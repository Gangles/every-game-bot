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

// need a static IP for certain queries: https://addons.heroku.com/proximo
var proximo = require('url').parse(process.env.PROXIMO_URL);
var options_proximo = {
	proxy : {
		host : proximo.hostname,
		port : proximo.port || 80,
		user : proximo.auth.split(':')[0],
		password : proximo.auth.split(':')[1]
	}
};
var proximoClient = new Client(options_proximo);

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
+ "minCorpusCount=3000&minDictionaryCount=15&hasDictionaryDef=true" +
+ "&excludePartOfSpeech=proper-noun-posessive,suffix,family-name,idiom,affix"
+ "&includePartOfSpeech=noun,proper-noun,adjective&limit=8&maxLength=10"
+ "&api_key=" + conf.wordnik_key;

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

var postTweetDone = false;
var dbInsertDone = false;

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
var MAX_ATTEMPTS = 30;
var DO_TWEET = true;

function waitToBegin() {
	// database is initialized, schedule tweet at :30 every 2 hours
	var d = new Date();
	var timeout = 60 - d.getSeconds();
	if (d.getHours() % 2 == 0)
		if (d.getMinutes() < 30)
			timeout += (30 - 1 - d.getMinutes()) * 60;
		else
			timeout += (150 - 1 - d.getMinutes()) * 60;
	else
		timeout += (90 - 1 - d.getMinutes()) * 60;
	if (!DO_TWEET) timeout = 1; // debugging

	// heroku scheduler runs every 10 minutes
	console.log("Wait " + timeout + " seconds for next tweet");
	if (timeout < 10 * 60)
		setTimeout(beginTweeting, timeout * 1000);
	else
		process.exit(0);
}

function beginTweeting() {
	// initialize the bag of APIs
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(boardGameGeekAPI);
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(giantBombAPI);
	randomAPIList.push(boardGameGeekAPI);

	// initialize the index based on hour
	var d = new Date();
	apiIndex = Math.floor(d.getHours() * 0.5) % randomAPIList.length;
	
	// post a tweet
	startNewTweet();
}

function startNewTweet() {
	try {
		// reset global variables
		gameToTweet = null;
		api = null;
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
		if (subjects.length > 0) subjects.shift();
		
		if (subjects.length > 0) {
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
		
		// grab some words from a set of common words in game titles
		var titleWords = fs.readFileSync('words_in_titles.json', 'ascii');
		titleWords = JSON.parse(titleWords);
		subjects.push(titleWords[Math.floor(Math.random() * titleWords.length)]);
		subjects.push(titleWords[Math.floor(Math.random() * titleWords.length)]);
		
		subjects = shuffle(subjects);
		chooseSubject();
	} catch (e) {
		console.log("Wordnik callback error:", e.toString());
	}
}

function chooseSubject() {
	try {
		if (subjects.length < 1) throw "Subject list should not be empty.";
		subject = subjects[0];
		
		if (contains(recentSubjects, subject)) {
			// we've used this subject recently
			console.log(subject + " used recently, get new subject.")
			getNewSubject();
		} else if (isOffensive(subject)) {
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
	if (api == null) api = randomAPIList[apiIndex];
	api.getGames(subject);
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
			if (++attempts < MAX_ATTEMPTS) {
				console.log("Querying Giant Bomb for " + subject);
				var URL = api.baseURL + api.searchURL + subject;
				URL += '&api_key=' + conf.giant_bomb_key;
				proximoClient.get(URL, api.gamesCallback, "json");
			} else {
				console.log("Failed after " + MAX_ATTEMPTS + " attempts.");
			}
		} catch (e) {
			console.log("Giant Bomb search error:", e.toString());
		}
	},
	
	getGame : function (game) {
		try {
			// ask giant bomb for details about the given game
			if (++attempts < MAX_ATTEMPTS) {
				console.log("Querying Giant Bomb about " + game.title);
				var URL = api.baseURL + 'game/3030-' + game.id;
				URL += '/?format=json&api_key=' + conf.giant_bomb_key;
				proximoClient.get(URL, api.gameCallback, "json");
			} else {
				console.log("Failed after " + MAX_ATTEMPTS + " attempts.");
			}
		} catch (e) {
			console.log("Giant Bomb query error:", e.toString());
		}
	},
	
	gamesCallback : function (data) {
		try {
			// parse the game list data from giant bomb
			api.games = JSON.parse(data.toString());
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
			var details = JSON.parse(data.toString());
			
			if (api.parseGameDetails(details.results)) {
				// candidate game found, check if we've tweeted it before
				gameToTweet.source = "Giant Bomb";
				return queryGameDB(gameToTweet);
			} else {
				// this game is unsuitable
				console.log("Game details are unsuitable, restart.");
				recentGames.push(gameToTweet.title);
				if (attempts % 5 == 0) {
					// occasionally try a new topic instead of continuing
					return getNewSubject();
				} else {
					// continue on the same topic
					return api.parseGameList();
				}
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
			} else {
				// failed to find an appropriate game, choose new subject
				return getNewSubject();
			}
		} catch (e) {
			console.log("Giant Bomb parsing error:", e.toString());
		}
	},
	
	parseGame : function (game) {
		var title = api.parseTitle(game);
		if (title.length < 3 || title.length > MAX_NAME_LENGTH) return null;
		if (isOffensive(title) || isNotEnglish(title)) return null;
		if (contains(recentGames, title)) return null;
		
		var thumbnail = api.parseThumbnail(game);
		if (thumbnail.length < 3) return null;
	
		var description = api.parseDescription(game);
		if (isOffensive(description)) return null;
		if (description.split(" ").length < 10) return null;
		
		var platform = api.parsePlatform(game);
		if (platform.length < 2) return null;
		
		console.log( ">> " + title);
		console.log( ">> " + platform);
		console.log( ">> " + "Thumbnail: " + thumbnail);
		console.log( ">> " + game.id);
		
		return {
			title: title,
			thumbnail: thumbnail,
			id: game.id,
			platform: platform
		};
	},
	
	parseGameDetails : function (game) {
		var dev = api.parseDevelopers(game);
		if (dev.length < 3 || isOffensive(dev)) return false;
		
		// way too many of these games...
		if (dev.indexOf('RailSimulator') >= 0) return false;
		
		var total = dev.length + gameToTweet.title.length;
		if (total > MAX_DEV_LENGTH + MAX_NAME_LENGTH) return false;
		
		var year = api.parseYear(game);
		if (year.length !== 4 || !/\d{4}/.test(year)) return false;
		if (parseInt(year) > new Date().getFullYear()) return false;
		
		var themes = api.parseThemes(game);
		if (contains(themes, "adult")) return false;
		
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
	
	parsePlatform : function(game) {
		if (game.hasOwnProperty('platforms')) {
			if (game.platforms !== null && game.platforms.length > 0) {
				// use shorter versions of some names
				var plat = game.platforms[0].name;
				if (/PlayStation \d/.test(plat)) {
					plat = game.platforms[0].abbreviation;
				} else if (plat.indexOf('PlayStation Network (PS3)') >= 0) {
					plat = 'PS3';
				} else if (plat.indexOf('PlayStation Network (Vita)') >= 0) {
					plat = 'PS Vita';
				} else if (plat.indexOf('PlayStation Vita') >= 0) {
					plat = 'PS Vita';
				} else if (plat.indexOf('PlayStation Network (PSP)') >= 0) {
					plat = 'PSP';
				} else if (plat.indexOf('PlayStation Portable') >= 0) {
					plat = 'PSP';
				} else if (plat.indexOf('Xbox 360 Games Store') >= 0) {
					plat = 'Xbox 360';
				} else if (plat.indexOf('Nintendo Entertainment') >= 0) {
					plat = game.platforms[0].abbreviation;
				} else if (plat.indexOf('3DS eShop') >= 0) {
					plat = 'Nintendo 3DS';
				} else if (plat.indexOf('Game.Com') >= 0) {
					plat = 'Game Com';
				}
				return plat;
			}
		}
		return "";
	},
	
	parseDevelopers : function (game) {
		if (game.hasOwnProperty('developers') && game.developers !== null) {
			var devs = game.developers;
			
			if (devs.length == 1) {
				return devs[0].name;
			} else if (devs.length == 2) {
				return devs[0].name + " & " + devs[1].name;
			} else if (devs.length > 2) {
				return devs[0].name + " et al.";
			}
		}
		// if there's no developer, a publisher will do...
		if (game.hasOwnProperty('publishers') && game.publishers !== null) {
			if (game.publishers.length > 0) {
				return game.publishers[0].name;
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
	},
	
	parseThemes : function (game) {
		if (game.hasOwnProperty('themes') && game.themes !== null) {
			var themes = [];
			for (var i = 0; i < game.themes.length; ++i) {
				themes.push(game.themes[i].name.toLowerCase());
			}
			return themes;
		}
		return [];
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
			if (++attempts < MAX_ATTEMPTS) {
				console.log("Querying Board Game Geek for " + subject);
				restClient.get(api.searchURL + subject, api.gamesCallback, "xml");
			} else {
				console.log("Failed to find a game after " + MAX_ATTEMPTS + " attempts.");
			}
		} catch (e) {
			console.log("Board Game Geek search error:", e.toString());
		}
	},
	
	getGame : function (game) {
		try {
			// get more info about an individual game
			if (++attempts < MAX_ATTEMPTS) {
				console.log("Querying Board Game Geek about " + game.title);
				restClient.get(api.gameURL + game.id, api.gameCallback, "xml");
			} else {
				console.log("Failed after " + MAX_ATTEMPTS + " attempts.");
			}
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
				// this game is unsuitable
				console.log("Game details are unsuitable, restart.");
				recentGames.push(gameToTweet.title);
				if (attempts % 5 == 0) {
					// occasionally try a new topic instead of continuing
					return getNewSubject();
				} else {
					// continue on the same topic
					return api.parseGameList();
				}
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
				return api.getGame(gameToTweet);
			} else {
				// failed to find an appropriate game, choose new subject
				return getNewSubject();
			}
		} catch (e) {
			console.log("Game list parsing error:", e.toString());
		}
	},
	
	parseGame : function (game) {		
		var title = api.parseTitle(game);
		if (title.length < 3 || title.length > MAX_NAME_LENGTH) return null;
		if (isOffensive(title) || isNotEnglish(title)) return null;
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
			if (cat[i].indexOf('miniatures') >= 0) return false;
		}
		
		// check if this game is an expansion
		if (api.parseExpansion(game)) return false;
		
		// check for an offensive description
		var desc = api.parseDescription(game);
		if (isOffensive(desc)) return false;
		
		// get the developers, if available
		var dev = api.parseDevelopers(game);
		if (dev.length < 3 || isOffensive(dev)) return false;
		
		var devlow = dev.toLowerCase();
		if (devlow.indexOf('uncredited') >= 0) return false;
		if (devlow.indexOf('unknown') >= 0) return false;
		if (devlow.indexOf('self-published') >= 0) return false;
		if (devlow.indexOf('web published') >= 0) return false;
		
		var total = dev.length + gameToTweet.title.length;
		if (total > MAX_DEV_LENGTH + MAX_NAME_LENGTH) return false;
		
		// get the year published, if available
		var year = api.parseYear(game);
		if (year.length !== 4 || !/\d{4}/.test(year)) return false;
		if (parseInt(year) > new Date().getFullYear()) return false;
		
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
			// make sure 'http' is prepended
			if (/^\/\//.test(game.image[0]))
				return 'http:' + game.image[0];
			else
				return game.image[0];
		}
		return "";
	},
	
	parseDevelopers : function (game) {
		if (game.hasOwnProperty('boardgamedesigner')) {
			var devs = game.boardgamedesigner;
			if (devs !== null) {
				if (devs.length == 1) {
					return devs[0]._;
				} else if (devs.length == 2) {
					return devs[0]._ + " & " + devs[1]._;
				} else if (devs.length > 2) {
					return devs[0]._ + " et al.";
				}
			}
		}
		// if there's no developer, a publisher will do...
		if (game.hasOwnProperty('boardgamepublisher')) {
			var devs = game.boardgamepublisher;
			if (devs !== null && devs.length > 0) {
				return devs[0]._;
			}
		}
		return "";
	},
	
	parseYear : function(game) {
		if (game.hasOwnProperty('yearpublished')) {
			if (game.yearpublished.length > 0) {
				return game.yearpublished[0];
			}
		}
		return "";
	},
	
	parseCategories : function (game) {
		// get the game's categories
		var categories = [];
		if (game.hasOwnProperty('boardgamecategory')) {
			var categoryList = game.boardgamecategory;
			if (categoryList !== null) {
				for (var i = 0; i < categoryList.length; ++i) {
					var cat = categoryList[i]._.toLowerCase().trim();
					categories.push(cat);
				}
			}
		}
		return categories;
	},
	
	parseExpansion : function (game) {
		// is this game an expansion to another game?
		if (game.hasOwnProperty('boardgameexpansion')) {
			var exp = game.boardgameexpansion;
			if (exp !== null && exp.length > 0) {
				if (exp[0].$.hasOwnProperty('inbound')) {
					return true;
				}
			}
		}
		return false;
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
			try {
				// get the size of the image
				var size = sizeOf(GAME_COVER);
				if (size.height <= 0) throw "Image height error";
				if (size.width <= 0) throw "Image width error";
			
				// resize the game cover to height 220
				var test = gm(GAME_COVER);
				var scale = 220 / size.height;
				test.resize(size.width * scale, size.height * scale, "!");
			
				// tile the cover horizontally if needed
				tile = Math.ceil((size.height * 2.25) / size.width) - 1;
				for (var i = 0; i < tile ; ++i) {
					test.append(GAME_COVER, true);
				}
				test.noProfile();
				test.write(TILE_COVER, thumbnailCallback);
			} catch (e) {
				console.log("Image tiling error:", e.toString());
			}
		});
	} catch (e) {
		console.log("Thumbnail error:", e.toString());
		return getNewSubject(); // try again!
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
		message += " by " + gameToTweet.developer;
		message += " (";
		if (gameToTweet.hasOwnProperty('platform')) {
			if (message.length + gameToTweet.platform.length < 111) {
				message += gameToTweet.platform + ", ";
			}
		}
		message += gameToTweet.year + ")";
		
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
		if(DO_TWEET && !postTweetDone) {
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
		postTweetDone = true;
		if (dbInsertDone) process.exit(0);
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
			dbInsertDone = true;
			if (postTweetDone) process.exit(0);
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

function isNotEnglish(text) {
	// does the given text contain non-english characters?
	if (text == null) return false;
	
	// Cyrillic characters
	if (/[\u0400-\u04FF]/.test(text)) return true;
	
	// Japanese characters
	if (/[\u3040-\u309F]/.test(text)) return true;
	if (/[\u30A0-\u30FF]/.test(text)) return true;
	if (/[\uFF00-\uFF9F]/.test(text)) return true;
	if (/[\u4E00-\u9FAF]/.test(text)) return true;
	
	// Chinese characters
	if (/[\u4E00-\u9FFF]/.test(text)) return true;
	if (/[\u3400-\u4DFF]/.test(text)) return true;
	if (/[\uF900-\uFAFF]/.test(text)) return true;
	
	// Korean characters
	if (/[\uAC00-\uD7AF]/.test(text)) return true;
	
	return false;
}

// start the application by initializing the db connection
initDB();