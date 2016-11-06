// Example express application adding the parse-server module to expose Parse
// compatible API routes.


// process.env.VERBOSE = 1


var express = require('express');
var ParseServer = require('parse-server').ParseServer;
var path = require('path');
var util = require('util');
var humanTime = require('human-time');

var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;

if (!databaseUri) {
  console.log('DATABASE_URI not specified, falling back to localhost.');
}

var serverConfig = {
  databaseURI: databaseUri,
  cloud: process.env.CLOUD_CODE_MAIN || __dirname + '/cloud/main.js',
  appId: process.env.APP_ID,
  masterKey: process.env.MASTER_KEY, //Add your master key here. Keep it secret!
  serverURL: process.env.SERVER_ROOT + process.env.PARSE_MOUNT,  // Don't forget to change to https if needed
  liveQuery: {
    classNames: [] // List of classes to support for query subscriptions
  }
};

var api = new ParseServer(serverConfig);
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


// Templating setup
var mustacheExpress = require('mustache-express');

// Register '.html' extension with The Mustache Express
app.engine('html', mustacheExpress());
app.set('view engine', 'html');


// Views
app.get('/join/:inviteId', function(req, res) {
  var inviteId = String(req.params.inviteId);
  
  var query = new Parse.Query(Parse.Object.extend("Invite"));
  query
    .include("inviter")
    .include("inviter.game")
    .include("inviter.user")
    .get(inviteId)
    .then(
      function(invite) {
        var inv = invite.toJSON();
        inv.createdAtHuman = humanTime(new Date(inv.createdAt));
        res.render("join", { invite: inv });
      },
      function(error) {
        res.render("join", { error: error });
      }
    );
});


if (process.env.TESTING === "true") {
    
  app.get('/createAccount', function(req, res) {
    var user = new Parse.User();
    user.set("username", req.query.user);
    user.set("displayName", req.query.display);
    user.set("password", req.query.pass);
    user.set("email", req.query.email);

    user.signUp().then(
      function(user) {
        res.status(200).send("Welcome " + user.get("username"));
      },
      function(error) {
        res.status(202).send(error);
      }
    );
  });


  app.get('/purgeContacts', function(req, res) {

    var userQuery = new Parse.Query(Parse.Object.extend("User"));
    userQuery
      .containedIn("username", ["Alice", "Bob", "Carol", "Dan"])
      .find()
      .then(
        function(users) {
          var contactQuery = new Parse.Query(Parse.Object.extend("Contact"));
          return contactQuery
            .containedIn("user", users)
            .find();
        }
      ).then(
        function(contacts) {
          return Parse.Object.destroyAll(contacts);
        }
      ).then(
        function() {
          res.status(200).send("Done!");
        },
        function(error) {
          res.status(500).send(error);
        }
      );

  });

  app.get('/purgeRandomGames', function(req, res) {

    var configQuery = new Parse.Query(Parse.Object.extend("Config"));
    configQuery
      .equalTo("isRandom", true);
    
    var query = new Parse.Query(Parse.Object.extend("Game"));
    query
      .matchesQuery("config", configQuery)
      .equalTo("state", 1)
      .find()
      .then(
        function(games) {
          if (games) {
            return Parse.Object.destroyAll(games);
          } else {
            return Parse.Promise.reject("No games found.");
          }
        }
      ).then(
        function() {
          res.status(200).send("Done!");
        },
        function(error) {
          res.status(500).send(error);
        }
      );

  });

}



// })



var port = process.env.PORT;
var httpServer = require('http').createServer(app);
httpServer.listen(port, function() {
    console.log('pbserver running on port ' + port + '.');
});

// This will enable the Live Query real-time server
ParseServer.createLiveQueryServer(httpServer);
