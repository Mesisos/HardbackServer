# pbserver

Paperback Server using the [parse-server](https://github.com/ParsePlatform/parse-server) module on Express.

# TODO

## Tasks
* [X] ~~*Move code to cloud functions*~~
* [X] ~~*Write script to create db schema*~~
* [X] ~~*Add beforeSave to avoid duplicate display names*~~
* [X] ~~*Add contacts on join game*~~
* [ ] Handle game state
	* [X] ~~*Init*~~
	* [X] ~~*Lobby*~~
	* [X] ~~*Running*~~
	* [X] ~~*Ended*~~
* [X] ~~*Go over questions and add missing tasks*~~
* [ ] Request random game
	* [X] ~~*Find a game*~~
	* [X] ~~*Join game*~~
	* [X] ~~*Create game if no random exists*~~
	* [ ] Actually don't create a game and just return failure
	* [ ] Just return a list of available random games?
	* [ ] Possible paging via date offset and number limit
	* [ ] Add the capability of joining into multiple lobbies (it shouldn't try joining in a game it's already in)
* [X] ~~*Look into Loom integration*~~
* [X] ~~*Fame card per-card counts*~~
* [ ] Add end game condition flag on game turn call
	* [X] ~~*End the game*~~
	* [ ] Send the save to all players (via push notifications?)
* [ ] Explicit 
* [ ] Fix maxSlots so it includes AI
* [ ] Index functions to cloud code with master key
* [ ] Allow start game by creator after timeout as long as two people are in it
* [ ] Join via link
* [ ] Add leaveGame, replace with AI? Game ends if <= 1 person remains?
* [ ] Skip to next player after turn timeout (48h?), cronjob or kue/redis with timed jobs, maybe don't actually skip, but provide the option for the next player to have a button that skips
* [ ] Replace defaultError with semantic errors
* [ ] Query limits?
* [ ] Filter returned User objects (listFriends etc.)

### Someday
* [ ] Blocking of friends?

## Questions
* [X] Are username and display name separate ala Steam? _Yes_
* [X] What are friends?
	* People you played with recently? _Yes_
	* Can you add them manually? _Only by playing with them via link_
	* Can you do anything with friends? _Start a game, delete them_
* [X] Does removing a friend block them and/or can you block people?
	* _It doesn't block, but we might want blocking at some point._
* [X] How does starting a game look? API call by creator only?
	* _I think once a game is full, it probably ought to autostart, since they aren't "live" (ie - once everyone has responded to the game request)._
	* _The creator ought to be allowed to start the game after the timer has expired, as long as there are two people in it_
* [X] When does a game stop?
	* _a game stops when a player wins :slightly_smiling_face: Probably need a call to notify of the game over condition, and then the file would be sent to all players (other than the person who ended the game).... maybe it's just a flag on the next turn call_
* [X] Can a player leave a game before it ends?
	* _Player leaving a game: I think a player could leave a game, at which point, they'd be replaced with an AI player.... Also, after a turn timeout (I've seen other games with turn timeouts of like 48 hours), the turn could be sent to the next player and just skip that persons turn, or we could send it with some info that says, "use an AI to play his turn"  skipping is probably easier_
	* What happens when the creator leaves the game?
		_I don't think it should matter - at the point the game starts, it's just round robin until it's done... creator is just another player_
* [X] Which states can a game be in? E.g. [Pending, Running, Ended], anything else?
	* _[Init, Lobby, Running, Ended]_
* [X] Does max slots include AI number or not? _It does!_
* [ ] Does the game end if < 2 people remain after players leave?
	_If there is only one human left, the game should still send it to the last player - and then the client can ask if they want to continue the game, and if they do, can just continue it as a solo game until it's finished, and then send the result to the server..._
* [ ] Request game
	* [ ] Does request game search with specific config? _Probably with a limited set._
	* [ ] Which config should it use for the lobby if no game exists? _It should probably just return a game/games instead of joining / creating automatically._

## Account
* [ ] Create account
* [X] ~~*Display name*~~
* [ ] Setup email verification
* [ ] Login
* [ ] Setup password recovery
* [ ] Track user devices?
* [ ] Obscene name filter? **beforeSave?**

## Ranking?

## Security
* [ ] Input validation
* [ ] Access security

# API

Subject to change.

All of the returned responses are wrapped in a `result` object if successful, otherwise an `error` is returned, e.g.:
```
{
	"code": 141
	"error": "Contact not found"
}
```

## Login

All of the cloud functions below require you to be logged in as a user.


## `checkNameFree`
### Request
```
{
	"displayName": "name"
}
```
### Response
```
{
	"available": true|false
}
```


## `createGame`
### Request
```
{
	// Doesn't include AI right now
	"slotNum": 2,

	"isRandom": true|false,
	"fameCards": {
		"The Chinatown Connection": 6,
		"Dead Planet": 4,
		"Vicious Triangle": 3,
		"Lady of the West": 1
	},
	"aiNum": 2,

	// Doesn't do anything right now
	"turnMaxSec": 60
}
```
### Response
```
// Game join response object
{
	// Game object
	"game": {
		"objectId": "id",
		"config": {
			"slotNum": 2,
			...
		}
		...
	},

	// Number of players after the game was joined
	"playerCount": 3,

	// Player object of the user
	"player": {
		"objectId": "id",
		...
	}
}
```


## `joinGame`
### Request
```
{
	"gameId": "id"
}
```
### Response
```
// Game join response object (see createGame)
{
	"game": {...},
	"playerCount": 3,
	"player": {...}
}
```


## `requestGame`
### Request
```
{}
```
### Response
```
// Game join response object (see createGame)
{
	"game": {...},
	"playerCount": 3,
	"player": {...}
}
```


## `listGames`
### Request
```
{
	// Optional, returns all games if omitted
	"gameIds": ["idA", "idB", ...]
}
```
### Response
```
{
	"games": [
		// Game one
		{
			"objectId": "idA",
			...
		},
		// Game two
		{
			"objectId": "idB",
			...
		},
		...
	]
}
```


## `listFriends`
### Request
```
{}
```
### Response
```
{
	"contacts": [
		// A lot of other info here will be stripped later
		{
			"displayName": "Ally",
			"objectId": "idA",
		},
		{
			"displayName": "Bobzor",
			"objectId": "idB"
		}
	]
}
```


## `deleteFriend`
### Request
```
{
	"userId": "id"
}
```
### Response
```
{
	"deleted": true
}
```


## `gameTurn`
### Request
```
{
	"gameId": "id",
	"state": "save contents",
	"final": true|false
}
```
### Response
```
{
	"saved": true,
	"ended": true|false
}
```



# Database Schema

See `schema/schema.json`.

# Gist
```
example save game https://gist.github.com/MarkFassett/4d256c6e526d92eaba3dccab6d0d384b

account flow
	1. create account
	2. click auth link sent to e-mail
	3. log in with user/pass

pw recovery flow
	4. request password recovery e-mail via ui
	5. link to click to reset pw and related form

new device login
	send notification e-mail
	keep track of user's devices

Challenge flow
	1. create game, set max slots
	2. send challenge link(s) or request random players
		if random flag set, then people can join by request random
	3. start play when ready (min 2 players)

Other items
	Need push notifications to drive play
	Should keep log of all games

Ranking system
	maybe just go by avg score due to absence of griefing/competitive scores?
	or by deviation from group norm to normalize for the cards?
	Or something even more or less clever...

/checkNameFree?displayName=

/createAccount?user=&login=&displayname=
	- check no obscene name
	- check unique display name

/authenticate?user=&login=&deviceId=
/recoverPassword?email=

/createGame?settings=
	get back shortlink to send to let people play with you
	properties
		max players
		# of fame cards (1-16)
		AI player count
		??? max turn time ??? - if expired next guy is notified and runs AI for the idle player

/requestGame
	used to join random game	
	create a lobby if none present
	lobbies will time out and start play to keep things going
	potentially secret AI?

/gameTurn?gameId&state
	Upload save game for next player and notify them it's ready
	16kb currently
	4 player will be couple kb more

/listGames
	get back state of all games you are involved in

/listFriends
	get list of all known buddies

/deleteFriend
	remove friend from list
```

# Parse Server

Read the full Parse Server guide here: https://github.com/ParsePlatform/parse-server/wiki/Parse-Server-Guide

### For Local Development

* Make sure you have at least Node 4.3. `node --version`
* Clone this repo and change directory to it.
* `npm install`
* Install mongo locally using https://docs.mongodb.com/master/administration/install-community/
* Run `mongo` to connect to your database, just to make sure it's working. Once you see a mongo prompt, exit with Control-D
* Run the server with: `npm start`
* By default it will use a path of /parse for the API routes.  To change this, or use older client SDKs, run `export PARSE_MOUNT=/1` before launching the server.
* You now have a database named "dev" that contains your Parse data
* Install ngrok and you can test with devices

### Getting Started With Heroku + mLab Development

#### With the Heroku Button

[![Deploy](https://www.herokucdn.com/deploy/button.png)](https://heroku.com/deploy)

#### Without It

* Clone the repo and change directory to it
* Log in with the [Heroku Toolbelt](https://toolbelt.heroku.com/) and create an app: `heroku create`
* Use the [mLab addon](https://elements.heroku.com/addons/mongolab): `heroku addons:create mongolab:sandbox --app YourAppName`
* By default it will use a path of /parse for the API routes.  To change this, or use older client SDKs, run `heroku config:set PARSE_MOUNT=/1`
* Deploy it with: `git push heroku master`

### Getting Started With AWS Elastic Beanstalk

#### With the Deploy to AWS Button

<a title="Deploy to AWS" href="https://console.aws.amazon.com/elasticbeanstalk/home?region=us-west-2#/newApplication?applicationName=ParseServer&solutionStackName=Node.js&tierName=WebServer&sourceBundleUrl=https://s3.amazonaws.com/elasticbeanstalk-samples-us-east-1/eb-parse-server-sample/parse-server-example.zip" target="_blank"><img src="http://d0.awsstatic.com/product-marketing/Elastic%20Beanstalk/deploy-to-aws.png" height="40"></a>

#### Without It

* Clone the repo and change directory to it
* Log in with the [AWS Elastic Beanstalk CLI](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/eb-cli3-install.html), select a region, and create an app: `eb init`
* Create an environment and pass in MongoDB URI, App ID, and Master Key: `eb create --envvars DATABASE_URI=<replace with URI>,APP_ID=<replace with Parse app ID>,MASTER_KEY=<replace with Parse master key>`

### Getting Started With Microsoft Azure App Service

#### With the Deploy to Azure Button

[![Deploy to Azure](http://azuredeploy.net/deploybutton.png)](https://azuredeploy.net/)

#### Without It

A detailed tutorial is available here:
[Azure welcomes Parse developers](https://azure.microsoft.com/en-us/blog/azure-welcomes-parse-developers/)


### Getting Started With Google App Engine

1. Clone the repo and change directory to it 
1. Create a project in the [Google Cloud Platform Console](https://console.cloud.google.com/).
1. [Enable billing](https://console.cloud.google.com/project/_/settings) for your project.
1. Install the [Google Cloud SDK](https://cloud.google.com/sdk/).
1. Setup a MongoDB server.  You have a few options:
  1. Create a Google Compute Engine virtual machine with [MongoDB pre-installed](https://cloud.google.com/launcher/?q=mongodb).
  1. Use [MongoLab](https://mongolab.com/google/) to create a free MongoDB deployment on Google Cloud Platform.
1. Modify `app.yaml` to update your environment variables.
1. Delete `Dockerfile`
1. Deploy it with `gcloud preview app deploy`

A detailed tutorial is available here:
[Running Parse server on Google App Engine](https://cloud.google.com/nodejs/resources/frameworks/parse-server)

### Getting Started With Scalingo

#### With the Scalingo button

[![Deploy to Scalingo](https://cdn.scalingo.com/deploy/button.svg)](https://my.scalingo.com/deploy)

#### Without it

* Clone the repo and change directory to it
* Log in with the [Scalingo CLI](http://cli.scalingo.com/) and create an app: `scalingo create my-parse`
* Use the [Scalingo MongoDB addon](https://scalingo.com/addons/scalingo-mongodb): `scalingo addons-add scalingo-mongodb free`
* Setup MongoDB connection string: `scalingo env-set DATABASE_URI='$SCALINGO_MONGO_URL'`
* By default it will use a path of /parse for the API routes. To change this, or use older client SDKs, run `scalingo env-set PARSE_MOUNT=/1`
* Deploy it with: `git push scalingo master`

### Getting Started With OpenShift Online (Next Gen)

1. Register for a free [OpenShift Online (Next Gen) account](http://www.openshift.com/devpreview/register.html)
1. Create a project in the [OpenShift Online Console](https://console.preview.openshift.com/console/).
1. Install the [OpenShift CLI](https://docs.openshift.com/online/getting_started/beyond_the_basics.html#btb-installing-the-openshift-cli).
1. Add the Parse Server template to your project: `oc create -f https://raw.githubusercontent.com/ParsePlatform/parse-server-example/master/openshift.json`
1. Deploy Parse Server from the web console
  1. Open your project in the [OpenShift Online Console](https://console.preview.openshift.com/console/):
  1. Click **Add to Project** from the top navigation
  1. Scroll down and select **NodeJS > Parse Server**
  1. (Optionally) Update the Parse Server settings (parameters)
  1. Click **Create**

A detailed tutorial is available here:
[Running Parse Server on OpenShift Online (Next Gen)](https://blog.openshift.com/parse-server/)

# Using it

Before using it, you can access a test page to verify if the basic setup is working fine [http://localhost:1337/test](http://localhost:1337/test).
Then you can use the REST API, the JavaScript SDK, and any of our open-source SDKs:

Example request to a server running locally:

```curl
curl -X POST \
  -H "X-Parse-Application-Id: myAppId" \
  -H "Content-Type: application/json" \
  -d '{"score":1337,"playerName":"Sean Plott","cheatMode":false}' \
  http://localhost:1337/parse/classes/GameScore
  
curl -X POST \
  -H "X-Parse-Application-Id: myAppId" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:1337/parse/functions/hello
```

Example using it via JavaScript:

```javascript
Parse.initialize('myAppId','unused');
Parse.serverURL = 'https://whatever.herokuapp.com';

var obj = new Parse.Object('GameScore');
obj.set('score',1337);
obj.save().then(function(obj) {
  console.log(obj.toJSON());
  var query = new Parse.Query('GameScore');
  query.get(obj.id).then(function(objAgain) {
    console.log(objAgain.toJSON());
  }, function(err) {console.log(err); });
}, function(err) { console.log(err); });
```

Example using it on Android:
```java
//in your application class

Parse.initialize(new Parse.Configuration.Builder(getApplicationContext())
  .applicationId("myAppId")
  .server("http://myServerUrl/parse/")   // '/' important after 'parse'
  .build());

ParseObject testObject = new ParseObject("TestObject");
testObject.put("foo", "bar");
testObject.saveInBackground();
```
Example using it on iOS (Swift):
```swift
//in your AppDelegate

Parse.initializeWithConfiguration(ParseClientConfiguration(block: { (configuration: ParseMutableClientConfiguration) -> Void in
  configuration.server = "https://<# Your Server URL #>/parse/" // '/' important after 'parse'
  configuration.applicationId = "<# Your APP_ID #>"
}))
```
You can change the server URL in all of the open-source SDKs, but we're releasing new builds which provide initialization time configuration of this property.
