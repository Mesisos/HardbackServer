// Example express application adding the parse-server module to expose Parse
// compatible API routes.


// process.env.VERBOSE = 1


var express = require('express');
var ParseServer = require('parse-server').ParseServer;
var path = require('path');
var util = require('util');

var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;

if (!databaseUri) {
  console.log('DATABASE_URI not specified, falling back to localhost.');
}

var serverConfig = {
  databaseURI: databaseUri || 'mongodb://127.0.0.1:27017/dev',
  cloud: process.env.CLOUD_CODE_MAIN || __dirname + '/cloud/main.js',
  appId: process.env.APP_ID || 'myAppId',
  masterKey: process.env.MASTER_KEY || '12345', //Add your master key here. Keep it secret!
  serverURL: process.env.SERVER_URL || 'http://127.0.0.1:1337/parse',  // Don't forget to change to https if needed
  liveQuery: {
    classNames: [] // List of classes to support for query subscriptions
  }
};

console.log(serverConfig);

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

// There will be a test page available on the /test path of your server url
// Remove this before launching your app
app.get('/test', function(req, res) {
  res.sendFile(path.join(__dirname, '/public/test.html'));
});







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
          .find()
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
    )

});




// })



var port = process.env.PORT || 1337;
var httpServer = require('http').createServer(app);
httpServer.listen(port, function() {
    console.log('pbserver running on port ' + port + '.');
});

// This will enable the Live Query real-time server
ParseServer.createLiveQueryServer(httpServer);
