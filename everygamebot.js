var fs = require('fs');
var path = require('path');
var request = require('request');
var conf = require('./config.js');

// twitter library: https://github.com/ttezel/twit
var Twitter = require('node-twitter');
var twitterRestClient = new Twitter.RestClient(
	conf.consumer_key,
	conf.consumer_secret,
	conf.access_token,
	conf.access_token_secret
);

// XML parsing: https://github.com/Leonidas-from-XIV/node-xml2js
xml2js = require('xml2js');

// postgres database to track games we've already tweeted
var pg = require('pg.js');
var client = new pg.Client(process.env.DATABASE_URL);

// image manipulation: https://github.com/aheckmann/gm
var gm = require('gm').subClass({ imageMagick: true });
var sizeOf = require('image-size');

// rest client: https://github.com/aacerox/node-rest-client
var Client = require('node-rest-client').Client;
var restClient = new Client();

// avoid using slurs: https://github.com/dariusk/wordfilter/
var blacklist = [];
try {
	var data = fs.readFileSync('blacklist.json', 'ascii');
	data = JSON.parse(data);
	blacklist = data.badwords;
	console.log("Blacklist initialized with " + blacklist.length + " words.")
} catch (err) {
	console.log(err);
	process.exit(1);
}

// wordnik API
var getNounsURL = "http://api.wordnik.com/v4/words.json/randomWords?"
+ "minCorpusCount=4000&minDictionaryCount=20&hasDictionaryDef=true&" +
+ "excludePartOfSpeech=proper-noun-posessive,suffix,family-name,idiom,affix&"
+ "includePartOfSpeech=noun,proper-noun&limit=10&maxLength=12&api_key=" + conf.wordnik_key;

// make sure the temp folder exists
try {
	var temp_dir = path.join(process.cwd(), 'tmp/');
	if (!fs.existsSync(temp_dir)) fs.mkdirSync(temp_dir);
} catch (err) {
	console.log(err);
	process.exit(1);
}

// global bot variables
var subject = "";
var subjects = [];
var gameToTweet = null;

var MAX_NAME_LENGTH = 53;
var MAX_DEV_LENGTH = 53;

var GAME_COVER = path.join(process.cwd(), '/tmp/cover.png');
var TILE_COVER = path.join(process.cwd(), '/tmp/cover_tiled.png');

var DB_CREATE = 'CREATE TABLE IF NOT EXISTS games '
 + '(title varchar(' + MAX_NAME_LENGTH + ') NOT NULL, source varchar(20))';
var DB_QUERY = 'SELECT * FROM games WHERE upper(title) = upper($1)';
var DB_INSERT = 'INSERT INTO games(title, source) VALUES ($1, $2)';

var recentGames = [];
var recentSubjects = [];
var MAX_MEMORY = 300;

var randomAPIList = [];
var apiIndex = 0;
var api = null;

var attempts = 0;
var MAX_ATTEMPTS = 5;
var DO_TWEET = true;

function waitToBegin() {
	// database is initialized, schedule tweet every hour at :30
	var d = new Date();
	target = d.getMinutes() < 30? 30 : 90;
	var timeout = 60 - d.getSeconds();
	timeout += (target - d.getMinutes() - 1) * 60;
	console.log("Wait " + timeout + " for first tweet.");
	setTimeout(beginTweeting, timeout * 1000);
}

function beginTweeting() {
	// initialize the random bag of APIs
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(boardGameGeekAPI);
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(boardGameGeekAPI);
	apiIndex = randomAPIList.length;
	
	// post a tweet, repeat every 60 minutes
	startNewTweet();
	setInterval(startNewTweet, 1000 * 60 * 60);
}

function startNewTweet() {
	try {
		// reset global variables
		gameToTweet = null;
		attempts = 0;
		
		// limit how long before games/subjects can be reused
		while (recentGames.length > MAX_MEMORY) recentGames.shift();
		while (recentSubjects.length > MAX_MEMORY) recentSubjects.shift();
		
		// delete any leftover cover images
		if(fs.existsSync(GAME_COVER)) fs.unlinkSync(GAME_COVER);
		if(fs.existsSync(TILE_COVER)) fs.unlinkSync(TILE_COVER);
	
		// get a new random subject
		getNewSubject();
	} catch (e) {
		console.log("Initial setup error:", e.toString());
	}
}

function getNewSubject() {
	try {
		// pop the most recently used subject
		if(subjects.length > 0) subjects.shift();
		
		if(subjects.length > 0) {
			// use a locally cached subject
			chooseSubject();
		} else {
			// ask wordnik for random words
			restClient.get(getNounsURL, subjectCallback, "json");
		}
	} catch (e) {
		console.log("Wordnik request error:", e.toString());
	}
}

function subjectCallback(data) {
	try {
		// add all the new words to the local cache
		var words = JSON.parse(data);
		for (var i = 0; i < words.length; i++) {
			subjects.push(words[i].word);
		}
		chooseSubject();
	} catch (e) {
		console.log("Wordnik callback error:", e.toString());
	}
}

function chooseSubject() {
	try {
		if (subjects.length < 1) throw "Subject list should not be empty.";
		subject = subjects[0];
		
		if(contains(recentSubjects, subject)) {
			// we've used this subject recently
			console.log(subject + " used recently, get new subject.")
			getNewSubject();
		} else if(isOffensive(subject)) {
			// bad word filter found a match
			console.log(subject + " is offensive, get new subject.")
			getNewSubject();
		} else {
			// get games for this subject
			console.log("Look up games for: " + subject);
			getGames(subject);
		}
	} catch (e) {
		console.log("Subject error:", e.toString());
	}
}

function getGames(subject) {
	// ask the API for a list of games
	api = getRandomAPI();
	api.getGames(subject);
}

function getRandomAPI() {
	// choose a random game API to query
	++apiIndex;
	if( apiIndex > randomAPIList.length - 1 ) {
		randomAPIList = shuffle(randomAPIList);
		apiIndex = 0;
	}
	return randomAPIList[apiIndex];
}

var giantBombAPI = {
	// URLs for querying this API
	baseURL : 'http://www.giantbomb.com/api/',
	searchURL : 'search/?format=json&resources=game&query=',
	games : [],
	resultCount : 0,
	
	getGames : function (subject) {
		try {
			// ask giant bomb for games on the given subject
			console.log("Querying Giant Bomb for " + subject);
			var URL = api.baseURL + api.searchURL + subject;
			URL += '&api_key=' + conf.giant_bomb_key;
			restClient.get(URL, api.gamesCallback, "json");
		} catch (e) {
			console.log("Giant Bomb search error:", e.toString());
		}
	},
	
	getGame : function (game) {
		try {
			// ask giant bomb for games on the given subject
			console.log("Querying Giant Bomb about " + game.title);
			var URL = api.baseURL + 'game/3030-' + game.id;
			URL += '/?format=json&api_key=' + conf.giant_bomb_key;
			restClient.get(URL, api.gameCallback, "json");
		} catch (e) {
			console.log("Giant Bomb query error:", e.toString());
		}
	},
	
	gamesCallback : function (data) {
		try {
			// parse the game list data from giant bomb
			api.games = JSON.parse(data);
			api.resultCount = 0;
			if (api.games.hasOwnProperty('number_of_page_results')) {
				api.resultCount = api.games.number_of_page_results;
				console.log( api.resultCount + " games found on " + subject );
			}
			api.parseGameList();
		} catch (e) {
			console.log("Giant Bomb search callback error:", e.toString());
		}
	},
	
	gameCallback : function (data) {
		try {
			// parse the individual game data from giant bomb
			var details = JSON.parse(data);
			
			if (api.parseGameDetails(details.results)) {
				// candidate game found, check if we've tweeted it before
				gameToTweet.source = "Giant Bomb";
				return queryGameDB(gameToTweet);
			} else {
				// this game is unsuitable, continue down the list
				console.log("Failed to find game details, restart.");
				recentGames.push(gameToTweet.title);
				return api.parseGameList();
			}
		} catch (e) {
			console.log("Giant Bomb game callback error:", e.toString());
		}
	},

	parseGameList : function () {
		try {
			// go through the list of games, find one to tweet
			gameToTweet = null;
			if (api.resultCount > 0 && api.games.hasOwnProperty('results')) {
				var shuffled = shuffle(api.games.results);
				for (var i = 0; i < shuffled.length; ++i) {
					if (shuffled[i].resource_type == 'game') {
						gameToTweet = api.parseGame(shuffled[i]);
					}
					if (gameToTweet !== null) break;
				}
			}
			
			if (gameToTweet !== null) {
				// candidate game found, get more information
				return api.getGame(gameToTweet);
			} else if (attempts < MAX_ATTEMPTS) {
				// failed to find an appropriate game, choose new subject
				++ attempts;
				return getNewSubject();
			} else {
				// too many attempts, give up for now
				console.log("Failed to find a game after " + MAX_ATTEMPTS + " attempts.");
			}
		} catch (e) {
			console.log("Giant Bomb parsing error:", e.toString());
		}
	},
	
	parseGame : function (game) {
		var title = api.parseTitle(game);
		if (title.length < 3 || title.length > MAX_NAME_LENGTH) return null;
		if (isOffensive(title)) return null;
		if (contains(recentGames, title)) return null;
	
		var thumbnail = api.parseThumbnail(game);
		if (thumbnail.length < 3) return null;
	
		var description = api.parseDescription(game);
		if (isOffensive(description)) return null;
	
		console.log( ">> " + title);
		console.log( ">> " + "Thumbnail: " + thumbnail);
		console.log( ">> " + game.id);
		
		return { title: title, thumbnail: thumbnail, id: game.id };
	},
	
	parseGameDetails : function (game) {
		var dev = api.parseDevelopers(game);
		if (isOffensive(dev)) return false;
		if (dev.length < 3 || dev.length > MAX_DEV_LENGTH) dev = "";
		
		var year = api.parseYear(game);
		if (year.length !== 4) year = "";
		
		gameToTweet.developer = dev;
		gameToTweet.year = year;
		return true;
	},
	
	parseTitle : function (game) {
		return game.hasOwnProperty('name')? game.name : "";
	},

	parseDescription : function (game) {
		var desc = "";
		if (game.hasOwnProperty('description')) {
			desc += game.description == null? "" : game.description;
		}
		if (game.hasOwnProperty('deck')) {
			desc += " " + game.deck == null? "" : game.deck;
		}
		return desc;
	},

	parseThumbnail : function (game) {
		if (game.hasOwnProperty('image') && game.image !== null) {
			if (game.image.hasOwnProperty('small_url')) {
				return game.image.small_url;
			}
		}
		return "";
	},
	
	parseDevelopers : function (game) {
		if (game.hasOwnProperty('developers')) {
			var devs = game.developers;
			if (devs == null) {
				return "";
			} else if (devs.length == 1) {
				return devs[0].name;
			} else if (devs.length == 2) {
				return devs[0].name + " & " + devs[1].name;
			} else if (devs.length > 2) {
				return devs[0].name + " et al.";
			} else {
				return "";
			}
		}
		return "";
	},
	
	parseYear : function (game) {
		if (game.hasOwnProperty('expected_release_year')) {
			if (game.expected_release_year !== null) {
				return game.expected_release_year;
			}
		}
		if (game.hasOwnProperty('original_release_date')) {
			if (game.original_release_date !== null) {
				return game.original_release_date.substring(0, 4);
			}
		}
		return "";
	}
};

var boardGameGeekAPI = {
	// URLs for querying this API
	searchURL : 'http://www.boardgamegeek.com/xmlapi/search?search=',
	gameURL : 'http://www.boardgamegeek.com/xmlapi/boardgame/',
	games : [],
	
	getGames : function (subject) {
		try {
			// ask BGG for some games on the given subject
			console.log("Querying Board Game Geek for " + subject);
			restClient.get(api.searchURL + subject, api.gamesCallback, "xml");
		} catch (e) {
			console.log("Board Game Geek search error:", e.toString());
		}
	},
	
	getGame : function (game) {
		try {
			// get more info about an individual game
			console.log("Querying Board Game Geek about " + game.title);
			restClient.get(api.gameURL + game.id, api.gameCallback, "xml");
		} catch (e) {
			console.log("Board Game Geek query error:", e.toString());
		}
	},
	
	gamesCallback : function(data) {
		var parser = new xml2js.Parser();
		parser.parseString(data, api.gamesXMLCallback);
	},
	
	gamesXMLCallback: function(err, result) {
		try {
			if (err) throw err;

			api.games = [];
			if (result.boardgames.hasOwnProperty("boardgame")) {
				api.games = shuffle(result.boardgames.boardgame);
			}
			console.log(api.games.length + " board games found.");
			api.parseGameList();
		} catch (e) {
			console.log("Search XML error:", e.toString());
		}
	},
	
	gameCallback : function(data) {
		var parser = new xml2js.Parser();
		parser.parseString(data, api.gameXMLCallback);
	},
	
	gameXMLCallback: function(err, result) {
		try {
			if (err) throw err;
			
			var details = result.boardgames.boardgame[0];
			
			if (api.parseGameDetails(details)) {
				// candidate game found, check if we've tweeted it before
				gameToTweet.source = "Board Game Geek";
				return queryGameDB(gameToTweet);
			} else {
				// this game has no thumbnail, continue through the list
				++attempts;
				console.log("Failed to find thumbnail, restart.");
				recentGames.push(gameToTweet.title);
				return api.parseGameList();
			}
		} catch (e) {
			console.log("Game XML error:", e.toString());
		}
	},
	
	parseGameList : function () {
		try {
			gameToTweet = null;
			for (var i = 0; i < api.games.length; ++i) {
				gameToTweet = api.parseGame(api.games[i]);
				if (gameToTweet !== null) break;
			}
			
			if (gameToTweet !== null) {
				// candidate game found, get more information
				api.getGame(gameToTweet);
			} else if (attempts < MAX_ATTEMPTS) {
				// failed to find an appropriate game, choose new subject
				++ attempts;
				return getNewSubject();
			} else {
				// too many attempts, give up for now
				console.log("Failed to find a game after " + MAX_ATTEMPTS + " attempts.");
			}
		} catch (e) {
			console.log("Game list parsing error:", e.toString());
		}
	},
	
	parseGame : function (game) {		
		var title = api.parseTitle(game);
		if (title.length < 3 || title.length > MAX_NAME_LENGTH) return null;
		if (isOffensive(title)) return null;
		if (contains(recentGames, title)) return null;
		
		var id = game.$.objectid;
		
		console.log( ">> " + title);
		console.log( ">> " + id);
		return { title: title, id: id };
	},
	
	parseTitle : function (game) {
		if (game.hasOwnProperty('name')) {
			if (game.name[0].hasOwnProperty('_')) {
				return game.name[0]._;
			}
		}
		return "";
	},
	
	parseGameDetails : function (game) {
		// check for irrelevant categories
		var cat = api.parseCategories(game);
		for (var i = 0; i < cat.length; ++i) {
			if (cat[i].indexOf('adult') >= 0) return false;
			if (cat[i].indexOf('book') >= 0) return false;
			if (cat[i].indexOf('expansion') >= 0) return false;
		}
		
		// check for an offensive description
		var desc = api.parseDescription(game);
		if (isOffensive(desc)) return false;
		
		// get the developers, if available
		var dev = api.parseDevelopers(game);
		if (dev.length < 3 || dev.length > MAX_DEV_LENGTH) dev = "";
		if (dev.indexOf('Uncredited') >= 0) dev = "";
		if (dev.indexOf('Unknown') >= 0) dev = "";
		
		// get the year published, if available
		var year = api.parseYear(game);
		if (year.length !== 4) year = "";
		
		// make sure the thumbnail exists
		var thumbnail = api.parseThumbnail(game);
		if (thumbnail.length < 3) return false;
		
		gameToTweet.developer = dev;
		gameToTweet.year = year;
		gameToTweet.thumbnail = thumbnail;
		return true;
	},
	
	parseThumbnail : function (game) {
		// get the game's thumbnail image
		if (game.hasOwnProperty('image') && game.image.length > 0) {
			return game.image[0];
		}
		return "";
	},
	
	parseDevelopers : function (game) {
		if (game.hasOwnProperty('boardgamedesigner')) {
			var devs = game.boardgamedesigner;
			if (devs == null) {
				return ""
			} else if (devs.length == 1) {
				return devs[0]._;
			} else if (devs.length == 2) {
				return devs[0]._ + " & " + devs[1]._;
			} else if (devs.length > 2) {
				return devs[0]._ + " et al.";
			} else {
				return "";
			}
		}
		return "";
	},
	
	parseYear : function(game) {
		if (game.hasOwnProperty('yearpublished')) {
			if(game.yearpublished.length > 0) {
				return game.yearpublished[0];
			}
		}
		return "";
	},
	
	parseCategories : function (game) {
		// get the game's categories
		var categories = [];
		if (game.hasOwnProperty('boardgamecategory')) {
			for (var i = 0; i < game.boardgamecategory.length; ++i) {
				categories.push(game.boardgamecategory[i]._.toLowerCase().trim());
			}
		}
		return categories;
	},
	
	parseDescription : function (game) {
		// get the game's description
		if (game.hasOwnProperty('description')) {
			if (game.description !== null && game.description.length > 0) {
				return game.description[0];
			}
		}
		return "";
	}
};

function initDB() {
	try {
		// connect to postgres db
		client.connect(function(err) {
			// connected, make sure table exists
			if (err) return console.log('DB init error:', err);
			client.query(DB_CREATE, function(err) {
				// table exists, start tweeting
				if (err) return console.log('DB init error:', err);
				console.log("Database initialized.");
				waitToBegin();
			});
		});
	} catch (e) {
		console.log("DB init error:", e.toString());
	}
}

function queryGameDB(game) {
	try {
		// check if the given game's title exists in the database
		client.query(DB_QUERY, [game.title], function(err, result) {
			if (err) {
				return console.error('DB query error:', err);
			} else if (result.rows.length > 0) {
				// we've tweeted this game in the past
				console.log(game.title + " has already been tweeted");
				recentGames.push(game.title);
				getNewSubject(); // restart
			} else {
				// game has never been tweeted before, proceed
				console.log(game.title + " has never been tweeted");
				getThumbnailImage(game.thumbnail);
			}
		});
	} catch (e) {
		console.log("DB query error:", e.toString());
	}
}

function getThumbnailImage(URL) {
	try {
		// get the game cover from the URL
		var image = request(URL);
		var stream = fs.createWriteStream(GAME_COVER);
		image.pipe(stream);
		stream.on('close', function() {
			// get the size of the image
			var size = sizeOf(GAME_COVER);
			if (size.height <= 0) throw "Image height error";
			if (size.width <= 0) throw "Image width error";
			
			// resize the game cover to height 220
			var test = gm(GAME_COVER);
			var scale = 220 / size.height;
			test.resize(size.width * scale, size.height * scale, "!");
			
			// tile the cover horizontally if needed
			tile = Math.ceil((size.height * 2) / size.width) - 1;
			for (var i = 0; i < tile ; ++i) {
				test.append(GAME_COVER, true);
			}
			test.noProfile();
			test.write(TILE_COVER, thumbnailCallback);
		});
	} catch (e) {
		console.log("Thumbnail error:", e.toString());
	}
}

function thumbnailCallback(err) {
	if (!err) {
		console.log("Successfully tiled the cover.");
		prepareTweet();
	} else {
		console.log("Thumbnail error:", err);
	}
}

function prepareTweet() {
	try {
		// assemble the tweet
		var message = gameToTweet.title;
		if(gameToTweet.developer.length > 0) {
			message += " by " + gameToTweet.developer;
		}
		if(gameToTweet.year.length == 4) {
			message += " (" + gameToTweet.year + ")";
		}
		
		// make sure the cover exists
		if(fs.existsSync(TILE_COVER)) {
			postTweet(message);
		} else {
			throw "Tiled cover image missing.";
		}
		
		// avoid reusing these values
		api.games = [];
		recentGames.push( gameToTweet.title );
		recentSubjects.push( subject );
		insertGameDB( gameToTweet );
	} catch (e) {
		console.log("Tweet assembly error:", e.toString());
	}
}

function postTweet(message) {
	try {
		// post a new status to the twitter API
		console.log("Posting tweet:", message);
		if(DO_TWEET) {
			twitterRestClient.statusesUpdateWithMedia({
				'status': message,
				'media[]': TILE_COVER
			}, postCallback);
		}
	} catch (e) {
		console.log("Twitter error:", e.toString());
	}
}

function postCallback(error, result) {
	// twitter API callback from posting tweet
	if (!error) {
		console.log("Post tweet success!");
	}
	else {
		console.log("Post tweet error:", error);
	}
}

function insertGameDB(game) {
	try {
		// add the given game's name to the database
		client.query(DB_INSERT, [game.title, game.source], function(err, result) {
			if (err) return console.error('DB insert error:', err);
			console.log("Game successfully added to database.");
		});
	} catch (e) {
		console.log("DB insert error:", e.toString());
	}
}

function contains(array, obj) {
	// convenience function
	for (var i = 0; i < array.length; i++) {
		if (array[i].indexOf(obj) >= 0) {
			return true;
		}
	}
	return false;
}

function randomSeeded() {
	// some deployments don't seed random numbers well
	var d = new Date();
	var s = d.getDate() + d.getHours() + d.getMilliseconds();
	for(var i = s % 30; i < 30 ; i++) Math.random();
	return Math.random();
}

function shuffle(array) {
	// randomly shuffle the given array
	randomSeeded();
	var current = array.length,
		tempValue, rIndex;
	while (0 !== current) {
		// choose a random element
		rIndex = Math.floor(Math.random() * current);
		current -= 1;
		
		// swap with current
		tempValue = array[current];
		array[current] = array[rIndex];
		array[rIndex] = tempValue;
	}
	return array;
}

function isOffensive(text) {
	// detect any offensive word on the blacklist
	for (var i = 0; i < blacklist.length; i++) {
		if (text.toLowerCase().indexOf( blacklist[i] ) >= 0) {
			console.log( blacklist[i] + " is offensive." );
			return true;
		}
	}
	return false;
}

// start the application by initializing the db connection
initDB();