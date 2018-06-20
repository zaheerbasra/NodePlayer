'use strict';
/*
Debug setup
*/
const ALL_DEBUG = 1;
const BASIC_DEBUG = 2;
const DATA_DEBUG = 4;		// Deeper data messaging
const FOCUS_DEBUG = 8;		// Focus on something new
const ERROR_DEBUG = 16;
const WATCHER_DEBUG = 32;	// Debug messages related to watching certain variable values, like counting up regions and loading them
const WEBSOCK_DEBUG = 64;	// Triggers when messages are sent or received via websock
const ZIP_DEBUG = 128;		// Messages related to unzipping files
const PRICE_DEBUG = 256;	// Anything pricing related
const TIME_DEBUG = 512;		// Related to adjusting timezones for modifying the date/time to match EST
const EXEC_DEBUG = 1024;	// Debugs related to starting programs
const TRIGGER_DEBUG = 2048;	// Debugs related to trigger contents
const CONFIG_DEBUG = 4096;		// Shows info for Config File loading
const IPADDR_DEBUG = 8192;		// Brief output regarding IP addresses and network interfaces

var debug = BASIC_DEBUG | TRIGGER_DEBUG | DATA_DEBUG | IPADDR_DEBUG;

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
var http = require('http')
var server = require('http').createServer();
var unzip = require('decompress');
app.set('view engine', 'ejs');
var rootpath = (process.platform === 'win32' ? __dirname.replace(/\\/g, '/').replace(/^C:/i, '') : __dirname) + '/';
var os = require('os');

var connectedPlayers = 0;

var triggerContentTimeOut = 5000;

/*
This flag will control if this player is the
syncrinization one or the trigger content one
*/
var syncPlayer = false;
// In case it is sync, we would require these two flags for master and just one or none for clients
var syncIsMaster = false;
var syncClients = [ "192.168.0.25:3000" ];

var syncMessage = "playplaylistfromstart";

var timezoneOffset

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
	connectedPlayers++;
	ws.on('message', function incoming(data) {
		if(syncMessage == data)
		{
			debugLog(TRIGGER_DEBUG, 'Received message: ' + data);
			if(syncIsMaster)
			{
				for(var i = 0; i < syncClients.length; i++) {
					var syncClient = syncClients[i];
					debugLog(TRIGGER_DEBUG, 'Client: ' + syncClient);
					try {
						//const ws = new WebSocket.Server({ port : 3001, host : syncClient });
						const ws = new WebSocket('ws://' + syncClient);
						ws.on('open', function open() {
							ws.send(syncMessage);
						});
					} catch (error) {
						debugLog(ERROR_DEBUG, 'Error: ' + error);
					}
				}
			} else {
				wss.broadcast(syncMessage);
			}
		}
	});
	ws.on('close', function () {
		connectedPlayers--;
		if (connectedPlayers < 0)
			connectedPlayers = 0;
		debugLog(BASIC_DEBUG, 'Client disconnected');
	});
	ws.send('connected');
	ws.on('error', (err) => {
		if (err.code !== 'ECONNRESET') {
			debugLog(BASIC_DEBUG, 'Error received - ' + err);
		}
	});
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

/*
Execution setup
Allows execution of outside programs.	Specifically we want to run Chrome at the moment in kiosk mode, but it could also run other programs like our entire suite of upkeep programs
*/

var path = require("path");
var exec = require("child_process").exec;
var pathToChrome = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
var chromex86 = true;
if (!fs.existsSync(pathToChrome)) {
	debugLog(EXEC_DEBUG, 'Unable to find ' + pathToChrome);
	chromex86 = false;
}

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
			debugLog(PRICE_DEBUG, result);
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


// Get config file, based on new necessary fields for triggering as per work with Zaheer/Steven
var globalConfig = {};
function getConfigFile() {
	var files = fs.readdirSync('.');
	for (var x = 0, len = files.length; x < len; x++) {
		if (files[x].startsWith('NodePlayer') && files[x].endsWith('.config')) {
			var configFile = fs.readFileSync(files[x],'utf-8', function (err) {
				if (err) debugLog(ERROR_DEBUG, err);
			});
			parseString(configFile, function(err, result) {
				if (err) { debugLog(ERROR_DEBUG, err); }
				var configRaw = result.configuration.appSettings[0].add;
				/*result.configuration.appSettings.add.forEach(obj => {
					globalConfig[obj.key] = obj.value;
				});//*/
				console.dir(configRaw[0]);
				for (var line in Object.keys(configRaw)) {
					debugLog(CONFIG_DEBUG, "new line["+configRaw[line]["$"].key+"]:"+configRaw[line]["$"].value);
					globalConfig[configRaw[line]["$"].key] = configRaw[line]["$"].value;
				}
				debugLog(CONFIG_DEBUG, "globalConfig:" + JSON.stringify(globalConfig, null, 3));
			});
		}
	}
	globalConfig["IPAddress"] = getIPAddress();
}


// Get server's IP address
function getIPAddress() {
	const os = require('os');
	var interfaces = os.networkInterfaces();
	var returnIPs = {};

	debugLog(IPADDR_DEBUG, "Diving into interfaces:" + Object.keys(interfaces).length);
	Object.keys(interfaces).forEach(interfaceName => {
		var alias = 0;
		debugLog(IPADDR_DEBUG, "Investigating interface:"+interfaceName);
		interfaces[interfaceName].forEach(interfaceEntry => {
			if ('IPv4' != interfaceEntry.family || interfaceEntry.internal !== false) {
				return;
			}
			debugLog(IPADDR_DEBUG, "-Data["+interfaceEntry.family+"]:"+interfaceEntry.address);
			returnIPs[interfaceName+alias] = interfaceEntry.address;
			++alias;
		});
	});
	if (Object.keys(returnIPs).length > 1) {
		for (let key of returnIPs.keys()) {
			if (key == 'eth0') {
				return returnIPs[key];
			}
		}
	} else {
		return returnIPs[Object.keys(returnIPs)[0]];
	}
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
// Modified to include an hour offset to correct to EST, because Aziz magic
function checkDate(check1, check2) {
	if (check1.getHours() + getHourOffset() > check2.getHours() + getHourOffset()) {  // If the hours are greater, you know it comes after
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

// Returns the hourly offset based on the timezone, the difference we need to add to make a time correct for our system
// Remember, getTimezoneOffset() returns minutes, not actual hours.
function getHourOffset() {
	var today = new Date();
	var tzOffset =  today.getTimezoneOffset() / 60;
	if (today.isDstObserved()) {
		debugLog(TIME_DEBUG, "DST in effect.  tzOffset + 1");
		tzOffset += 1;
	}
	debugLog(TIME_DEBUG, "Timezone Offset: " + tzOffset);
	if (tzOffset > 5) {
		debugLog(TIME_DEBUG, "Returning " + (tzOffset - 5));
		return (tzOffset - 5);
	} else if (tzOffset < 5) {
		debugLog(TIME_DEBUG, "Returning " + (tzOffset + 5));
		return (tzOffset + 5);
	} else {
		return 0;
	}
}

// Adjusts a date to be in line with EST
function adjustHours(inDate) {
	var newDate = inDate;
	debugLog(TIME_DEBUG, "Adjusting time by " + getHourOffset());
	newDate.setTime(newDate.getTime() + (getHourOffset() * 60 * 60 * 1000));
	return newDate;
}

// Returns the absolute seconds difference between two dates, ignoring days
function timeDiff(date1, date2) {
	return Math.abs(((date1.getHours() * 60*60) + (date1.getMinutes() * 60) + date1.getSeconds()) - ((date2.getHours() * 60*60) + (date2.getMinutes() * 60) + date2.getSeconds()));
}

/**
 * In order to test this trigger content process, please post the following JSON to below url
http://lorcos.ur-channel.com/TriggerApp/TriggeredContentService/PostSignal
POST
content-type:	application/json
{
	"MediaItems": [{
		"AssetType": "Movie",
		"Path": "COBS_Bread_Cape_Baguette_Final_Feb15.mp4",
		"Duration": 30,
		"Height": 1080,
		"Width": 1920,
		"Left": 0,
		"Top": 0
	}],
	"SignalKey": "DEMORIGHTA0"
}
 *
 */
function getTriggerdContents() {
	var playerId = os.hostname();
	if ([ 'CA-MSS-DEV05', 'DESKTOP-1JQ9LQV'].includes(playerId))
	{
		playerId = 'TCC-COBSTESTA0';
	}

	if (connectedPlayers === 0) return;
	/*var options = {
		hostname: "lorcos.ur-channel.com",
		port: 80,
		path: "/TriggerApp/TriggeredContentService/" + playerId,
		method: "GET"
	};*/

	var options = {
		method: "GET",
		port: 80,
		hostname: globalConfig.triggerGetHost,
		path: globalConfig.triggerGetPath + playerId
	}
	debugLog(TRIGGER_DEBUG,'Calling with path: ' + options.hostname + options.path);
	var req = http.request(options, function(res) {

		var responseBody = "";

		//debugLog(TRIGGER_DEBUG,`Server Status: ${res.statusCode}`);
		//debugLog(TRIGGER_DEBUG,"Response Headers: %j", res.headers);

		res.setEncoding("UTF-8");

		res.on("data", function(chunk){
			responseBody += chunk;
		});

		res.on("end", function(chunk){

			if(responseBody.length > 1) {
				debugLog(TRIGGER_DEBUG,responseBody);
				var obj = JSON.parse(responseBody);
				for (var media of obj.MediaItems) {
					console.dir(media);
					media.Path = media.Path.replace(/\\/g, "/");
					media.Path = media.Path.replace(new RegExp('C:/URChannel/', 'i'), "");
				}
				debugLog(TRIGGER_DEBUG,obj.MediaItems);
				if(obj.MediaItems.length > 0) {
					wss.broadcast('triggercontent:' + JSON.stringify(obj));
				}
			}
		});
	});

	req.on("error", function(err){
		console.log('Problem with the request: ${err.message}');
	});

	req.end();

}

if(!syncPlayer)
{
	// this will keep triggering the get contents every 10 second
	setInterval(getTriggerdContents, triggerContentTimeOut);
}

// Internet copy pasta for determining DST
Date.prototype.stdTimezoneOffset = function () {
	var jan = new Date(this.getFullYear(), 0, 1);
	var jul = new Date(this.getFullYear(), 6, 1);
	return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

Date.prototype.isDstObserved = function () {
	return this.getTimezoneOffset() < this.stdTimezoneOffset();
}

// Content retrieval:  https://127.0.0.1/incoming/Media/<file name> returns the requested file, be it HTML or other.
// TODO:  Spits out an error if the file doesn't exist, should look into catching that at some point.
// Note:  Zip file downloads are not supported, as we should never be sending zips to the browser.  Just their contents.
app.all('/incoming/:path*', function (req, res, next) {
	switch (req.params[0].slice(req.params[0].lastIndexOf('.'))) {
		case '.zip':
			res.send('File request: /incoming/' + req.params.path + req.params[0]);
			break;
		case '.html':
			debugLog(DATA_DEBUG, "Got HTML request: " + rootpath + "../incoming/" + req.params.path + req.params[0]);
			debugLog(DATA_DEBUG, "Renaming index.html to ejs");
			var htmlToEjs = req.params.path + req.params[0].replace(/\..{0,4}$/i, '.ejs');
			fs.rename(rootpath + '../incoming/' + req.params.path + req.params[0], rootpath + '../incoming/'+htmlToEjs, function(err) {
				if (err) {
					if (err.code !== 'ENOENT') {
						throw err;
					}
				}
			});
			if (fs.existsSync(rootpath + '../incoming/' + htmlToEjs)) {
				res.render(rootpath + '../incoming/'+ htmlToEjs, getPriceFile());
			} else {
				debugLog(FOCUS_DEBUG, 'Unzip running slow, adding timer to retry render');
				var contentTimer = setInterval(function () {
					if (fs.existsSync(rootpath + '../incoming/' + htmlToEjs)) {
						res.render(rootpath + '../incoming/'+ htmlToEjs, getPriceFile());
						clearInterval(contentTimer);
					}
				}, 1000);
			}

			break;
		default:
			var options = {
				root: rootpath + '../incoming/',
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
		var foundShow = false;
		for (var x = 0; x < files.length; x++ ) {
			if (files[x].search(/_show\[r0c0\]/) >= 0) {
				showFileName = files[x].replace("_show\[r0c0\].sgf", ".show");
				debugLog(BASIC_DEBUG, "Found signal file: " + files[x] + " - Renaming to " + showFileName);
				foundShow = true;
				break;
			}
		}
		if (!foundShow) {
			debugLog("No show found!"); // TODO:  Make it fail gracefully
		}


		// Load the specified show file, extracting the item info from the first (and hopefully only!) region that has a date range including today
		fs.readFile(rootpath + '../incoming/ShowFiles/' + showFileName, 'utf-8', function (err, data) {
			var showFile = JSON.parse(data);
			var showStartDate = new Date(parseInt(showFile.StartTime.slice(6,-2)));
			showStartDate = adjustHours(showStartDate);
			var showEndDate = new Date(parseInt(showFile.EndTime.slice(6,-2)));
			showEndDate = adjustHours(showEndDate);
			debugLog(BASIC_DEBUG, 'Show times: ' + showStartDate.getTime() + ' - ' + showEndDate.getTime());
			var regions = [];
			var htmlOut = '';
			//var completeRegions = new Watcher(0, function(val) {return val >= regions.length;}, function() {res.render('index', {htmlOut: htmlOut});});
			var itemCount = 0;
			var countdownTime = -1;
			for (var region of showFile.Regions) {
				debugLog(BASIC_DEBUG, 'Region: ' + region.Name);
				// Iterate over the region entries looking for the current playlist
				for (var playlist of region.Playlists) {
					debugLog(DATA_DEBUG, playlist.Name);
					debugLog(DATA_DEBUG, 'date string:'+playlist.StartTime.slice(6,-2));
					var today = new Date();
					//today = adjustHours(today);
					var regionStartDate = new Date(parseInt(playlist.StartTime.slice(6,-2)));
					regionStartDate = adjustHours(regionStartDate);
					var regionEndDate = new Date(parseInt(playlist.EndTime.slice(6,-2)));
					regionEndDate = adjustHours(regionEndDate);
					if (regionEndDate.getSeconds() == 0) {
						regionEndDate.setSeconds(59);
					}
					debugLog(BASIC_DEBUG, 'startDate [' + regionStartDate + ']\ntoday ['+today+']\nendDate ['+regionEndDate+']');
					if ((playlist.RecurrenceRule == null && today > regionStartDate && today < regionEndDate) ||
						(playlist.RecurrenceRule != null && today > showStartDate && today < showEndDate && checkDate(today, regionStartDate) >= 0 && checkDate(today, regionEndDate) <= 0)) {
						/*debugLog('File name = ' + playlist.Items[0].Source);
					debugLog('mediaName = ' + playlist.Items[0].Name.replace(/[\&\s]/g,'').replace(/\..{0,4}$/i, ''));*/
						if (playlist.RecurrenceRule != null) {
							if (countdownTime < 0) {
								countdownTime = (timeDiff(today, regionEndDate) + 1) * 1000;
							} else {
								var newTime = (timeDiff(today, regionEndDate) + 1) * 1000;
								countdownTime = (countdownTime > newTime ? newTime : countdownTime);
							}
							debugLog(BASIC_DEBUG, 'RecurrenceRule not null, setting countdownTime to ' + countdownTime);
						}
						if (region.Width == 1279)
						region.Width = 1280;
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
							regions[regions.length-1].mediaInfo.push({ "source" : item.Source, "duration": item.DurationSeconds, "type" : item.AssetType.toLowerCase()});
						}
					}
				}
				itemCount++;
			}
			debugLog(BASIC_DEBUG, 'Found ' + itemCount + ' items to play');
			if (countdownTime > 0) {
				debugLog(BASIC_DEBUG, "A region has dayparting, setting timer to refresh page for " + countdownTime + "ms from now.");
				setTimeout(function () {
					debugLog(WEBSOCK_DEBUG, 'Dayparting timer expired, sending reload...');
					wss.broadcast('reload');
				}, countdownTime);
			}
			// Set up a Watcher to eventually render the page.  Passes in variables:  htmlOut (the eventual completed page contents) and IPAddr (the IP address of the server)
			var completeRegions = new Watcher(0, function(val) {return val >= itemCount;}, function() {
				htmlOut = htmlOut + '<script>var syncIsMaster = ' + syncIsMaster + ';</script>\n';
				res.render('index', {htmlOut: htmlOut, IPAddr: globalConfig['IPAddress']});
			});
			var renames = [];

			// Start building up HTML tags for the region <div> tags and the playlist <li> tags
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
					htmlOut = htmlOut + '<li class>' + JSON.stringify(jsonData) + '</li>\n';
				}
				htmlOut = htmlOut + '</div>\n';
				htmlOut = htmlOut + '<script>players["' + regions[x].name + '"] = new RegionPlayer("' + regions[x].name + '");</script>\n';
				htmlOut = htmlOut + '<script>window.setTimeout(' + regions[x].name + '.nextContentEvent, 1000);</script>\n';
				completeRegions.SetValue(completeRegions.GetValue()+1);
			}
		});
	});

});
// Get this party started
server.on('request', app);
server.listen(3000, function() {
	debugLog(BASIC_DEBUG, 'Starting http server:  *:3000');
	debugLog(CONFIG_DEBUG, 'Loading config file');
	getConfigFile();
	debugLog(BASIC_DEBUG, 'Attempting to launch Chrome');
	if (chromex86) {
		exec('"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" --kiosk --app-auto-launched 127.0.0.1:3000', (err, stdout, stderr) => {
			if (err) {
				debugLog(ERROR_DEBUG, 'Error in exec(): ' + err);
				return;
			}
			debugLog(EXEC_DEBUG, 'stdout: ' +stdout);
			debugLog(EXEC_DEBUG, 'stderr: ' +stderr);
		});
	} else {
		exec('"C:/Program Files/Google/Chrome/Application/chrome.exe" --kiosk --app-auto-launched 127.0.0.1:3000', (err, stdout, stderr) => {
			if (err) {
				debugLog(ERROR_DEBUG, 'Error in exec(): ' + err);
				return;
			}
			debugLog(EXEC_DEBUG, 'stdout: ' +stdout);
			debugLog(EXEC_DEBUG, 'stderr: ' +stderr);
		});
	}
});
