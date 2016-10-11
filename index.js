// Example express application adding the parse-server module to expose Parse
// compatible API routes.

var express = require('express');
var ParseServer = require('parse-server').ParseServer;
var path = require('path');
var util = require('util');

var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;

if (!databaseUri) {
  console.log('DATABASE_URI not specified, falling back to localhost.');
}

var api = new ParseServer({
  databaseURI: databaseUri || 'mongodb://localhost:27017/dev',
  cloud: process.env.CLOUD_CODE_MAIN || __dirname + '/cloud/main.js',
  appId: process.env.APP_ID || 'myAppId',
  masterKey: process.env.MASTER_KEY || '12345', //Add your master key here. Keep it secret!
  serverURL: process.env.SERVER_URL || 'http://localhost:1337/parse',  // Don't forget to change to https if needed
  liveQuery: {
    classNames: [] // List of classes to support for query subscriptions
  }
});
// Client-keys like the javascript key or the .NET key are not necessary with parse-server
// If you wish you require them, you can set them as options in the initialization above:
// javascriptKey, restAPIKey, dotNetKey, clientKey

var app = express();

// Serve static assets from the /public folder
app.use('/public', express.static(path.join(__dirname, '/public')));

// Serve the Parse API on the /parse URL prefix
var mountPath = process.env.PARSE_MOUNT || '/parse';
app.use(mountPath, api);

// Parse Server plays nicely with the rest of your web routes
app.get('/', function(req, res) {
  res.status(200).send('I dream of being a PB server.');
});

// There will be a test page available on the /test path of your server url
// Remove this before launching your app
app.get('/test', function(req, res) {
  res.status(200).send("Test???");
});






function sendError(res, error) {
  if (!error) {
    error = {
      code: -1,
      message: "Unknown error"
    };
  }
  res.status(202).send({
    status: "error",
    code: error.code,
    message: error.message
  });
}

function sendSuccess(res, data) {
  res.status(200).send({
    status: "success",
    data: data
  });
}


var Game = Parse.Object.extend("Game");
var Config = Parse.Object.extend("Config");
var Turn = Parse.Object.extend("Turn");
var GameState = {
  PENDING: 0
};

app.get('/createAccount', function(req, res) {
  var user = new Parse.User();
  user.set("username", req.query.user);
  user.set("password", req.query.pass);
  user.set("email", req.query.email);

  user.signUp().then(
    function(user) {
      res.status(200).send("Welcome " + user.get("username"));
    },
    function(error) {
      // console.log(res);
      // res.status(202).send("asdasdasd");
      sendError(res, error);
    }
  );
});

app.get('/checkNameFree', function(req, res) {
  var name = req.query.displayName;
  var query = new Parse.Query(Parse.User);
  
  query.equalTo("displayName", name);
  query.find().then(
    function(results) {
      sendSuccess(res, {
        available: results.length === 0
      });
    },
    sendError.bind(null, res)
  );
});

// http://localhost:1337/createGame?slotNum=4&isRandom=true&fameCardNum=6&aiNum=3&turnMaxSec=60

app.get('/createGame', function(req, res) {

  var config = new Config();
  config.set("slotNum", Number(req.query.slotNum));
  config.set("isRandom", req.query.isRandom == "true");
  config.set("fameCardNum", Number(req.query.fameCardNum));
  config.set("aiNum", Number(req.query.aiNum));
  config.set("turnMaxSec", Number(req.query.turnMaxSec));

  config.save().then(
    function(config) {
      
      var game = new Game();
      game.set("config", config);
      game.set("state", GameState.PENDING);
      game.set("turn", 0);
      game.save().then(
        function(game) {
          sendSuccess(res, {
            id: game.id
          });
        },
        function(gameError) {
          // Destroy config if creating the game was unsuccessful
          config.destroy().then(
            function(config) {
              sendError(res, gameError);
            }
          );
        }
      );

    },
    function(error) {
      sendError(res, error);
    }
  );

});


Parse.Cloud.afterDelete(Game, function(req) {
  var game = req.object;
  console.log(game.id);
  var config = game.get("config");
  config.destroy().then(
    function(config) {},
    function(error) {
      console.error("Unable to remove config", config.id);
    }
  );
});




app.get("/gameTurn", function(req, res) {
  var gameId = String(req.query.gameId);

  var query = new Parse.Query(Game);
  query.get(gameId).then(
    function(game) {

      var save = String(req.query.state);
      // TODO: validate
      // TODO: notify

      var turn = new Turn();
      turn.set("game", game);
      turn.set("turn", game.get("turn"));
      turn.set("save", save);
      turn.save().then(
        function(turn) {
          game.increment("turn");
          game.save();
          sendSuccess(res, {
            saved: true
          });
        }
      );

    },
    function(error) {
      sendError(res, error);
    }
  );
});


// TODO: add beforeSave validation
// Parse.Cloud.beforeSave(Game, function(req, res) {
//   var game = req.object;
// })



var port = process.env.PORT || 1337;
var httpServer = require('http').createServer(app);
httpServer.listen(port, function() {
    console.log('parse-server-example running on port ' + port + '.');
});

// This will enable the Live Query real-time server
ParseServer.createLiveQueryServer(httpServer);
