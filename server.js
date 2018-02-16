'use strict';
/*
Debug setup
*/
const ALL_DEBUG = 1;
const BASIC_DEBUG = 2;
const DATA_DEBUG = 4;
const FOCUS_DEBUG = 8;
const ERROR_DEBUG = 16;
const WATCHER_DEBUG = 32;
const WEBSOCK_DEBUG = 64;
const ZIP_DEBUG = 128;
const PRICE_DEBUG = 256;

var debug = ALL_DEBUG | BASIC_DEBUG | WEBSOCK_DEBUG | ZIP_DEBUG | FOCUS_DEBUG;

function debugLog(flag, msg) {
	if (debug & flag || flag & ERROR_DEBUG || debug & ALL_DEBUG) {
		console.log(msg);
	}
}

/*
Web server setup
*/
var express = require('express');
var app = express();
var fs = require('fs'), parseString = require('xml2js').parseString;
var ejs = require('ejs');
var server = require('http').createServer();
var unzip = require('decompress');
app.set('view engine', 'ejs');
var rootpath = (process.platform === 'win32' ? __dirname.replace(/\\/g, '/').replace(/^C:/i, '') : __dirname) + '/';


/*
Directory watching and remote restarting
*/

var watch = require('watch');
var WebSocket = require('ws');
var wss = new WebSocket.Server({server: server});
wss.broadcast = function broadcast(data) {
	debugLog(WEBSOCK_DEBUG, 'Broadcast called');
	wss.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN) {
			debugLog(WEBSOCK_DEBUG, 'Sending ' + data + ' to client');
			client.send(data);
		}
	});
};
wss.on('connection', function connection(ws) {
	debugLog(BASIC_DEBUG, 'Client connected');
	ws.on('message', function incoming(data) {
		debugLog(WEBSOCK_DEBUG, 'Received message: ' + data);
	});
	ws.on('close', function () {debugLog(BASIC_DEBUG, 'Client disconnected');});
	ws.send('connected');
});
watch.watchTree('/Urchannel/SignalFiles', function (f, curr, prev) {
	debugLog(WEBSOCK_DEBUG, 'Found change in signal files, triggering reload');
	wss.broadcast('reload');
});
if (fs.existsSync('/btv/incoming/PriceFiles/price.xml')) {
	watch.watchTree('/btv/incoming/PriceFiles', function (f, curr, prev) {
		debugLog(WEBSOCK_DEBUG, 'Found change in price file, triggering reload');
		wss.broadcast('reload');
	});
}
watch.watchTree(__dirname, function (f, curr, prev) {
	debugLog(WEBSOCK_DEBUG, 'Found change in NodePlayer, triggering reload');
	wss.broadcast('reload');
});


/*
Watcher setup for fs.existsSync checking
*/

function timedFSCheck(callback) {
	debugLog(FOCUS_DEBUG, 'Retrying render');
	callback();
}


/*
Implementation
*/

// A test based callback trigger.  When the specified variable meets the specified test, perform callback function
// watchVar is a variable reference.  ChangeTest is a function receiving the watchVar.  Callback is the function to run (without arguments).
function Watcher(watchVar, ChangeTest, Callback) {
	this.watchVar = watchVar;
	this.ChangeTest = ChangeTest;
	this.Callback = Callback;

	this.GetValue = function() {
		return this.watchVar;
	}

	this.SetValue = function(val) {
		this.watchVar = val;
		debugLog('Set value: ' + this.watchVar);
		if (this.ChangeTest(this.watchVar)) {
			debugLog(WATCHER_DEBUG, 'Doing callback');
			this.Callback();
		}
	}
}

// Get price files for use in playback.
function getPriceFile() {
	// Hard coded location because this is where the price file is placed by other programs
	var priceFile = null;
	if (fs.existsSync('/btv/incoming/PriceFiles/price.xml')) {
		priceFile = fs.readFileSync('/btv/incoming/PriceFiles/price.xml', 'utf-8', function (err) {
			if (err) debugLog(ERROR_DEBUG, err);
		});
	} else {
		debugLog(BASIC_DEBUG, 'No price file present, returning null')
	}
	if (priceFile !== null) {
		parseString(priceFile, function(err, result) {
			if (err) { debugLog(ERROR_DEBUG, err); }
			debugLog(DATA_DEBUG, result);
			if (result.specials !== null) {
				priceFile = result.specials;
			}
		});
		debugLog(PRICE_DEBUG, 'Total of ' + Object.keys(priceFile).length + ' entries');
		debugLog(PRICE_DEBUG, 'Found items:');
		for (item in priceFile.keys) {
			priceFile[item] = priceFile[item][0].trim();
			debugLog(PRICE_DEBUG, '|-' + item + ':' + priceFile[item]);
		}
	}
	return priceFile;
}

// Removes a directory, recursively.  Used to clear old extracted zip files for HTML content.
function rmdirRecursively(path) {
	if (fs.existsSync(path)) {
		fs.readdirSync(path).forEach(function(file, index){
			var curPath = path + "/" + file;
	  if (fs.lstatSync(curPath).isDirectory()) { // recurse
	  	rmdirRecursively(curPath);
	  } else { // delete file
	  	fs.unlinkSync(curPath);
	  }
	});
		fs.rmdirSync(path);
	}
};

// Determines whether the first date is before or after the second, in terms of hh:mm:ss
// Returns -1 for before, 1 for after, or 0 for exactly the same time of day (even if not the same date)
function checkDate(check1, check2) {
	if (check1.getHours() > check2.getHours()) {  // If the hours are greater, you know it comes after
		return 1;
	} else if (check1.getHours() < check2.getHours()) { // Likewise if they're less, then you know it comes before
		return -1;
	} else {
		if (check1.getMinutes() > check2.getMinutes()) { // Same with minutes
			return 1;
		} else if (check1.getMinutes() < check2.getMinutes()) {
			return -1;
		} else {
			if (check1.getSeconds() > check2.getSeconds()) {
				return 1;
			} else if (check1.getSeconds() < check2.getSeconds()) {
				return -1;
			} else {
				return 0; // At this stage there's functionally no difference in the time of day, barring milliseconds, and we don't track that precisely.
			}
		}
	}
}

// Content retrieval:  https://127.0.0.1/incoming/Media/<file name> returns the requested file, be it HTML or other.
// TODO:  Spits out an error if the file doesn't exist, should look into catching that at some point.
// Note:  Zip file downloads are not supported, as we should never be sending zips to the browser.  Just their contents.
app.all('/incoming/Media/:path*', function (req, res, next) {
	switch (req.params[0].slice(req.params[0].lastIndexOf('.'))) {
		case '.zip':
		res.send('File request: /incoming/Media/' + req.params.path + req.params[0]);
		break;
		case '.html':
		debugLog(DATA_DEBUG, "Got HTML request: " + rootpath + "../incoming/Media/" + req.params.path + req.params[0]);
		debugLog(DATA_DEBUG, "Renaming index.html to ejs");
		var htmlToEjs = req.params.path + req.params[0].replace(/\..{0,4}$/i, '.ejs');
		fs.rename(rootpath + '../incoming/Media/' + req.params.path + req.params[0], rootpath + '../incoming/Media/'+htmlToEjs, function(err) {
			if (err) {
				if (err.code !== 'ENOENT') {
					throw err;
				}
			}
		});
		if (fs.existsSync(rootpath + '../incoming/Media/' + htmlToEjs)) {
			res.render(rootpath + '../incoming/Media/'+ htmlToEjs, getPriceFile());
		} else {
			debugLog(FOCUS_DEBUG, 'Unzip running slow, adding timer to retry render');
			var contentTimer = setInterval(function () {
				if (fs.existsSync(rootpath + '../incoming/Media/' + htmlToEjs)) {
					res.render(rootpath + '../incoming/Media/'+ htmlToEjs, getPriceFile());
					clearInterval(contentTimer);
				}
			}, 1000);
		}

		break;
		default:
		var options = {
			root: rootpath + '../incoming/Media/',
			headers: {
				'x-timestamp': Date.now(),
				'x-sent': true
			}
		};
		res.sendFile(req.params.path + req.params[0], options, function (err) {
			if (err) {
				if (err.code !== 'ECONNABORTED') {
					next(err);
				}
			} else {
				debugLog(DATA_DEBUG, 'Served file: ' + req.params.path + req.params[0]);
			}
		});
	}
});

// Main block
// Returns a base HTML page using EJS to populate fields.
// Parses the appropriate show file for necessary region data and sets up specified regions as DIV tags.
app.get('/', function (req, res) {
	var showFileName;

	debugLog(BASIC_DEBUG, 'Looking in ' + rootpath + '../SignalFiles');

	// Find all the signal files, the _show[r0c0] one will be the one we want to load
	fs.readdir(rootpath + '../SignalFiles', function(err, files) {
		debugLog(DATA_DEBUG, 'Files: ' + files);
		for (var x = 0; x < files.length; x++ ) {
			if (files[x].search(/_show\[r0c0\]/) >= 0) {
				showFileName = files[x].replace("_show\[r0c0\].sgf", ".show");
				debugLog(BASIC_DEBUG, "Found signal file: " + files[x] + " - Renaming to " + showFileName);
				break;
			}
		}

		// Load the specified show file, extracting the item info from the first (and hopefully only!) region that has a date range including today
		fs.readFile(rootpath + '../incoming/ShowFiles/' + showFileName, 'utf-8', function (err, data) {
			var showFile = JSON.parse(data);
			var showStartDate = new Date(parseInt(showFile.StartTime.slice(6,-2)));
			var showEndDate = new Date(parseInt(showFile.EndTime.slice(6,-2)));
			debugLog(BASIC_DEBUG, 'Show times: ' + showStartDate.getTime() + ' - ' + showEndDate.getTime());
			var regions = [];
			var htmlOut = '';
			//var completeRegions = new Watcher(0, function(val) {return val >= regions.length;}, function() {res.render('index', {htmlOut: htmlOut});});
			var itemCount = 0;
			for (var region of showFile.Regions) {
				debugLog(BASIC_DEBUG, 'Region: ' + region.Name);
				// Iterate over the region entries looking for the current playlist
				for (var playlist of region.Playlists) {
					debugLog(DATA_DEBUG, playlist.Name);
					debugLog(DATA_DEBUG, 'date string:'+playlist.StartTime.slice(6,-2));
					var today = new Date();
					var regionStartDate = new Date(parseInt(playlist.StartTime.slice(6,-2)));
					var regionEndDate = new Date(parseInt(playlist.EndTime.slice(6,-2)));
					debugLog(BASIC_DEBUG, 'startDate [' + regionStartDate + ']\ntoday ['+today+']\nendDate ['+regionEndDate+']');
					if ((playlist.RecurrenceRule == null && today > regionStartDate && today < regionEndDate) ||
						(playlist.RecurrenceRule != null && today > showStartDate && today < showEndDate && checkDate(today, regionStartDate) >= 0 && checkDate(today, regionEndDate) <= 0)) {
						/*debugLog('File name = ' + playlist.Items[0].Source);
						debugLog('mediaName = ' + playlist.Items[0].Name.replace(/[\&\s]/g,'').replace(/\..{0,4}$/i, ''));*/
						regions.push({
							"x": (region.CanvasLeft / 1280) * 100,
							"y": (region.CanvasTop / 720) * 100,
							"w": (region.Width / 1280) * 100,
							"h": (region.Height /720) * 100,
							"name": region.Name,
							"mediaName": playlist.Name.replace(/[\&\s]/g,''),
							"mediaInfo": []
						});
						// Push a bunch of items onto the stack for this region for future playback
						for (var item of playlist.Items) {
							/*var itemType = item.AssetType;
							switch (itemType) {
								case 'Movie':
								itemType = 'video';
								break;
								case 'Zip':
								itemType = 'html';
								break;
								default:
								itemType = itemType.toLowerCase();
							}*/
							regions[regions.length-1].mediaInfo.push({ "source" : item.Source, "duration": item.DurationSeconds, "type" : item.AssetType.toLowerCase()});
						}
					}
				}
				itemCount++;
			}
			debugLog(BASIC_DEBUG, 'Found ' + itemCount + ' items to play');
			var completeRegions = new Watcher(0, function(val) {return val >= itemCount;}, function() {res.render('index', {htmlOut: htmlOut});});
			var renames = [];

			// Start building up HTML tags for the region <div> tags and the playlist <li> tags.
			// Also extract any zip files (clearing out old data) for future use
			for (var x = 0; x < regions.length; x++) {
				debugLog(BASIC_DEBUG, "region["+x+"]: " + regions[x].x + "," + regions[x].y + " - " + regions[x].w + "," + regions[x].h + " - name: " + regions[x].name);
				var positioningStuff = 'position:absolute;top:' + regions[x].y + '%;left:' + regions[x].x+ '%;width:' + regions[x].w + '%;height:' + regions[x].h +'%;z-index:'+x+';';
				/*var divStart*/ htmlOut = htmlOut + '<div id="'+regions[x].name+'" style="' +positioningStuff+'"></div>\n';
				htmlOut = htmlOut + '<div id="'+regions[x].name+'-playlist" style="display:none;">\n'
				for (var y = 0; y < regions[x].mediaInfo.length ; y++) {
					var jsonData = {"source": "/incoming" + regions[x].mediaInfo[y].source, "type" : regions[x].mediaInfo[y].type, "Duration" : regions[x].mediaInfo[y].duration};
					if (regions[x].mediaInfo[y].type === 'zip') {
						debugLog(ZIP_DEBUG, 'Extracting zip contents');
						jsonData.source = jsonData.source.replace(/\..{0,4}$/i,'/index.html');
						jsonData.type = 'html';
						if (fs.existsSync(rootpath + '../incoming' + regions[x].mediaInfo[y].source.replace(/\..{0,4}$/i,''))) {
							debugLog(ZIP_DEBUG, 'Deleting current unzipped folder');
							rmdirRecursively(rootpath + '../incoming' + regions[x].mediaInfo[y].source.replace(/\..{0,4}$/i,''));
							debugLog(ZIP_DEBUG, 'Complete');
						}
						unzip(rootpath + '../incoming' + regions[x].mediaInfo[y].source, rootpath + '../incoming/Media/', {
							map: file => {
								file.path = file.path.replace(/\.html$/i,'.ejs');
								return file;
							}
						}).then(res => {
							var indexPath = '';
							if (res.path) {
								indexPath = res.path;
							} else if (res[0]) {
								indexPath = res[0].path;
							}
						}).catch(err => {
							debugLog(ERROR_DEBUG, 'Error in unzip process: ' + err.stack);
						});
					}
					debugLog(DATA_DEBUG, 'Configured new jsonData: ' + JSON.stringify(jsonData));
					/*switch (regions[x].mediaPath.slice(regions[x].mediaPath.lastIndexOf('.'))) {
						case '.zip':
						debugLog('Zip stuff: ' + regions[x].mediaPath);
						if (fs.existsSync('c:/Urchannel/incoming' + regions[x].mediaPath.replace(/\..{0,4}$/i,''))) {
							debugLog('Deleting current unzipped folder');
							rmdirRecursively('c:/Urchannel/incoming' + regions[x].mediaPath.replace(/\..{0,4}$/i,''));
							debugLog('Complete');
						}
						//htmlOut = htmlOut + divStart + '<iframe scrolling="no" src="/incoming' + regions[x].mediaPath.replace(/\..{0,4}$/i, '') + '/index.html' +'" style="border:none;" width="100%" height="100%"></iframe></div>\n';
						htmlOut = htmlOut + '<li class>' + JSON.stringify(jsonData) + '</li>'
						unzip('c:/Urchannel/incoming' + regions[x].mediaPath, 'c:/Urchannel/incoming/Media/', {
							map: file => {
								file.path = file.path.replace(/\.html$/i,'.ejs');
								return file;
							}
						}).then(res => {
							var indexPath = '';
							if (res.path) {
								indexPath = res.path;
							} else if (res[0]) {
								indexPath = res[0].path;
							}
							completeRegions.SetValue(completeRegions.GetValue()+1);
							debugLog('Added iframe for zip file: ' + indexPath.replace(/\/.*?$/i, '/') + 'index.html');
						}).catch(err => {
							debugLog('Error in unzip process: ' + err.stack);
						});
						break;
						case '.html':
						htmlOut = htmlOut + divStart + '<iframe scrolling="no" src="/incoming' + regions[x].mediaPath +'" style="border:none;" width="100%" height="100%"></iframe></div>\n';
						completeRegions.SetValue(completeRegions.GetValue()+1);
						break;
						case '.png':
						htmlOut = htmlOut + '<img src="/incoming' + regions[x].mediaPath +'" style="' + positioningStuff + '"' +'></img>\n';
						completeRegions.SetValue(completeRegions.GetValue()+1);
						break;
						case '.mp4':
						htmlOut = htmlOut + '<video style="' + positioningStuff + '" autoplay loop><source src="/incoming' + regions[x].mediaPath +'" type="video/mp4"></video>\n';
						completeRegions.SetValue(completeRegions.GetValue()+1);
					}*/
					htmlOut = htmlOut + '<li class>' + JSON.stringify(jsonData) + '</li>\n';
				}
				htmlOut = htmlOut + '</div>\n';
				htmlOut = htmlOut + '<script>var ' + regions[x].name + ' = new RegionPlayer("' + regions[x].name + '");</script>\n';
				completeRegions.SetValue(completeRegions.GetValue()+1);
			}
			/*if (completeRegions == regions.length) {
				res.render('index', {htmlOut: htmlOut});
			} else {
				debugLog('Reached render early.');
			}*/
		});
});

});
// Get this party started
//app.listen(3000, function () {
	server.on('request', app);
	server.listen(3000, function() {
		debugLog(BASIC_DEBUG, 'Starting http server:  *:3000');
	})
