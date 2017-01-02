module.exports = Object.freeze({

  FAME_CARD_NAMES: [
    "The Chinatown Connection",
    "Dead Planet",
    "Vicious Triangle",
    "Lady of the West"
  ],

  INVITE_URL_PREFIX: process.env.SERVER_ROOT + "/join/",

  GAME_DEFAULT_CONFIG: {
    slotNum: 4,
    isRandom: false,
    fameCards: {},
    aiDifficulty: 0,
    turnMaxSec: 10
  },

  START_GAME_MANUAL_TIMEOUT: 7,
  START_GAME_AUTO_TIMEOUT: 20,

  GAME_ENDING_INACTIVE_ROUNDS: 2,

  GAME_PAGING: {
    limit: {
      default: 20,
      min: 1,
      max: 100
    },
    sort: [ { name: "createdAt", dir: "descending" } ]
  },

  FIND_GAME_PAGING: {
    limit: {
      default: 20,
      min: 1,
      max: 100
    },
    sort: [ { name: "createdAt", dir: "ascending" } ]
  },

  TURN_PAGING: {
    limit: {
      default: 3,
      min: 1,
      max: 100
    },
    sort: [ { name: "createdAt", dir: "descending" } ]
  },

  CONTACT_PAGING: {
    limit: {
      default: 100,
      min: 1,
      max: 1000
    },
    sort: [ { name: "createdAt", dir: "descending" } ]
  },

  GameState: {
    Init: 0,
    Lobby: 1,
    Running: 2,
    Ended: 3,

    getName: function(state) {
      for (var prop in GameState) {
        if (GameState[prop] == state) return prop + " (" + state + ")";
      }
      return null;
    }
  },

  PlayerState: {
    Active: 0,
    Inactive: 1
  },

  AIDifficulty: {
    None:   0,
    Easy:   1,
    Medium: 2,
    Hard:   3
  },

  /**
   * Messages with codes and templates.
   */
  t: {

    AVAILABILITY: { id: 001 },

    GAME_CREATED: { id: 100 },
    GAME_STARTED: { id: 101, m:
      "Game {{game.objectId}} has started!"
    },
    GAME_ENDED: { id: 102, m:
      "Game {{game.objectId}} has ended!",
    },
    GAME_JOINED: { id: 103 },
    GAME_LEFT: { id: 104 },

    GAME_INVITE: { id: 105 },
    GAME_LIST: { id: 106 },

    GAME_LOBBY_TIMEOUT: { id: 120, m:
      "Game {{game.objectId}} timed out, nobody joined!"
    },
    GAME_INACTIVE_TIMEOUT: { id: 121, m:
      "Game {{game.objectId}} ran out!"
    },

    PLAYER_TURN: { id: 200, m:
      "It's your turn in game {{game.objectId}}!"
    },

    TURN_SAVED: { id: 300 },
    TURN_LIST: { id: 301 },

    CONTACT_LIST: { id: 400 },
    CONTACT_DELETED: { id: 401 },



    // Errors

    INVALID_PARAMETER: { id: 1001, m:
      "Invalid parameter"
    },
    UNKNOWN_ERROR: { id: 1002 },
    USER_NOT_FOUND: { id: 1004, m:
      "User not found."
    },

    GAME_INVALID_STATE: { id: 1100, m:
      "Game state '{{stateName}}' does not accept this operation. Supported states: {{acceptableNames}}"
    },
    GAME_NOT_STARTABLE: { id: 1101, m:
      "Game is not startable yet."
    },
    GAME_START_ERROR: { id: 1102, m:
      "Unable to start game."
    },
    GAME_INSUFFICIENT_PLAYERS: { id: 1103, m:
      "Not enough players to start the game."
    },
    GAME_NOT_FOUND: { id: 1104, m:
      "Game not found."
    },
    GAME_INVITE_ERROR: { id: 1105, m:
      "Unable to get invite."
    },
    GAME_FULL: { id: 1106, m:
      "Unable to join, game is full."
    },
    GAME_FULL_PLAYER_ERROR: { id: 1107, m:
      "Game is too full, but unable to remove player."
    },
    GAME_THIRD_PARTY: { id: 1108, m:
      "Unable to start a third party game."
    },
    GAME_INVALID_TIMEOUT: { id: 1109, m:
      "Invalid game timeout: {{timeout}}"
    },

    PLAYER_ALREADY_IN_GAME: { id: 1200, m: 
      "Player already in game."
    },
    PLAYER_NOT_IN_GAME: { id: 1201, m: 
      "Player not in game."
    },
    PLAYER_NOT_FOUND: { id: 1204, m:
      "Player not found."
    },
    PLAYER_NEXT_NO_CURRENT: { id: 1205, m:
      "Unable to find next player, no current player"
    },

    TURN_THIRD_PARTY: { id: 1300, m:
      "Unable to list third party turns."
    },
    TURN_NOT_IT: { id: 1301, m:
      "Game turn invalid, it's not your turn!"
    },

    CONTACT_NOT_FOUND: { id: 1404, m:
      "Contact not found."
    }

  }

});