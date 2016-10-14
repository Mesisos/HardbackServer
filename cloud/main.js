
var Game = Parse.Object.extend("Game");
var Config = Parse.Object.extend("Config");
var Turn = Parse.Object.extend("Turn");
var Player = Parse.Object.extend("Player");
var GameState = {
  PENDING: 0
};
function getGameStateName(state) {
  switch (state) {
    case GameState.PENDING: return "pending";
  }
  return "invalid";
}

Parse.Cloud.define('hello', function(req, res) {
  console.log("hi");
  res.success('Hi');
});



  // var user = new Parse.User();
  // user.setUsername("test");
  // user.signUp().then(
  //   function(results) {
  //     res.success("yay");
  //   },
  //   function(error) {
  //     res.error(error);
  //   }
  // );

function defaultError(res) {
  return (function(error) {
    res.error(error);
  });
}

function userInvalid(user, res) {
  var invalid = !user;
  if (invalid) res.error("User not found");
  return invalid;
}


Parse.Cloud.define("checkNameFree", function(req, res) {
  
  var name = req.params.displayName;
  if (!name || name == "") {
    res.error("Unable to check, invalid display name");
    return;
  }

  var query = new Parse.Query(Parse.User);
  query.equalTo("displayName", name);
  query.find().then(
    function(results) {
      res.success({
        available: results.length === 0
      });
    },
    defaultError(res)
  );
})




      // var game = new Game();
      // game.set("config", config);
      // game.set("state", GameState.PENDING);
      // game.set("turn", 0);
      // game.save().then(
      //   function(game) {
      //     res.success({
      //       id: game.id
      //     });
      //   },
      //   function(gameError) {
      //     // Destroy config if creating the game was unsuccessful
      //     config.destroy().then(
      //       function(config) {
      //         res.error(gameError);
      //       }
      //     );
      //   }
      // );




Parse.Cloud.define("createGame", function(req, res) {
  if (userInvalid(req.user, res)) return;

  createConfigFromRequest(req).then(
    function(config) {
      return createGameFromConfig(req.user, config);
    },
    defaultError(res)
  ).then(
    function(game) {
      res.success({
        id: game.id
      })
    },
    defaultError(res)
  );

});

function createConfigFromRequest(req) {
  var promise = new Parse.Promise();
  var config = new Config();
  config.set("slotNum", Number(req.params.slotNum));
  config.set("isRandom", req.params.isRandom == "true");
  config.set("fameCardNum", Number(req.params.fameCardNum));
  config.set("aiNum", Number(req.params.aiNum));
  config.set("turnMaxSec", Number(req.params.turnMaxSec));
  return config.save();
}

function createGameFromConfig(user, config) {
  var promise = new Parse.Promise();
  var game = new Game();
  game.set("config", config);
  game.set("state", GameState.PENDING);
  game.set("turn", 0);
  game.set("creator", user);
  game.save().then(
    function(game) {
      promise.resolve(game);
    },
    function(error) {
      config.destroy().then(
        function(config) {
          promise.reject(error);
        },
        function(destroyError) {
          promise.reject(destroyError);
        }
      )
    }
  );
  return promise;
}

Parse.Cloud.beforeDelete(Game, function(req, res) {
  var game = req.object;
  var config = game.get("config");

  var configP = config.destroy();

  var playersP = new Parse.Promise();
  var players = new Parse.Query(Player);
  players.equalTo("game", game);
  players.find().then(
    function(results) {
      return Parse.Object.destroyAll(results);
    },
    function(error) {
      playersP.reject("Unable to find player to destroy: " + error);
    }
  ).then(
    function() {
      playersP.resolve();
    },
    function(error) {
      playersP.reject("Unable to destroy all players: " + error);
    }
  );

  Parse.Promise.when([configP, playersP]).then(
    function() {
      res.success();
    },
    function(error) {
      res.error(error);
    }
  )

/*
  var turns = new Parse.Query(Turn);
  turns.equalTo("game", game);
  turns.find().then(
    function(results) {
      for (var i = 0; i < results.length; i++) {
        var turn = results[i];
        turn.destroy().then(
          function(player) {},
          function(error) {
            console.error("Unable to destroy player", error);
          }
        )
      }
    },
    function(error) {
      console.error("Unable to find player to destroy", error);
    }
  );
*/
});

Parse.Cloud.define("joinGame", function(req, res) {
  var user = req.user;
  if (userInvalid(user, res)) return;

  var gameId = String(req.params.gameId);
  var game;
  var player;
  var query = new Parse.Query(Game);
  query.get(gameId).then(
    function(g) {
      game = g;
      return getPlayer(game, user);
    },
    defaultError(res)
  ).then(
    function(p) {
      player = p;
      if (!game.get("currentPlayer")) {
        game.set("currentPlayer", player);
        return game.save();
      }
      return Parse.Promise.as(game);
    },
    defaultError(res)
  ).then(
    function(game) {
      res.success({
        playerId: player.id
      });
    },
    defaultError(res)
  )
});

function getPlayer(game, user) {
  var promise = new Parse.Promise();
  


  var player = new Player();
  player.set("game", game);
  player.set("user", user);
  player.save().then(
    function(player) { promise.resolve(player) },
    function(error) {
      promise.reject(error);
    }
  );

  return promise;
}

Parse.Cloud.beforeSave(Player, function(req, res) {
  var player = req.object;
  
  var query = new Parse.Query(Player);
  query.equalTo("game", player.get("game"));
  query.equalTo("user", player.get("user"));
  query.first().then(
    function(existing) {
      if (existing) {
        res.error("Player already in game");
      } else {
        res.success();
      }
    },
    function(error) {
      res.error(error);
    }
  );
});



Parse.Cloud.define("gameStatus", function(req, res) {
  var gameId = String(req.params.gameId);
  var query = new Parse.Query(Game);
  var game;
  query.get(gameId).then(
    function(g) {
      game = g;
      // console.log("got game!");
      var players = new Parse.Query(Player);
      players.equalTo("game", game);
      players.addAscending("createdAt");
      return players.find();
    },
    defaultError(res)
  ).then(
    function(players) {
      // console.log("got players!", game, players);
      var g = {
        state: getGameStateName(game.get("state")),
        turn: game.get("turn"),
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
        creator: game.get("creator"),
        config: game.get("config"),
        players: players
      };

      // console.log("got", g);
      res.success(g);
    },
    defaultError(res)
  );
});



Parse.Cloud.define("gameTurn", function(req, res) {
  if (userInvalid(req.user, res)) return;

  var gameId = String(req.params.gameId);
  var query = new Parse.Query(Game);
  query.include("currentPlayer");
  query.get(gameId).then(
    function(game) {

      var currentPlayer = game.get("currentPlayer");
      if (!currentPlayer || currentPlayer.get("user").id != req.user.id) {
        res.error("Game turn invalid, it's not your turn!");
        return;
      }

      var save = String(req.params.state);
      // TODO: validate
      // TODO: notify

      var turn = new Turn();
      turn.set("game", game);
      turn.set("save", save);
      turn.save().then(
        function(turn) {
          res.success({
            saved: true
          });
        }
      );

    },
    defaultError(res)
  );
});

Parse.Cloud.beforeSave(Turn, function(req, res) {
  var turn = req.object;
  var game = turn.get("game");

  var query = new Parse.Query(Game);
  query.include("currentPlayer");
  query.get(game.id).then(
    function(g) {
      game = g;

      turn.set("turn", game.get("turn"));
      game.increment("turn");

      var currentPlayer = game.get("currentPlayer");
      if (!currentPlayer) {
        res.error("Unable to save turn, no current player");
        return;
      }

      console.log(currentPlayer.createdAt);

      res.error("derp");
      return;

      // TODO change current player
      // TODO get next player by date
      // TODO wrap if no newer player found by getting the oldest player
      // TODO check player state (active, not disconnected, etc.)
      // TODO make sure that empty results due to player state or otherwise
      //      don't put the next player search into a frenzy or loop, add tests?
      return game.save();
    },
    defaultError(res)
  ).then(
    function(game) {
      res.success();
    },
    defaultError(res)
  );
});



// TODO: add beforeSave validation
// Parse.Cloud.beforeSave(Game, function(req, res) {
//   var game = req.object;
