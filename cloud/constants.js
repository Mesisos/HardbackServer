module.exports = Object.freeze({

  FAME_CARD_NAMES: [
    "The Chinatown Connection",
    "Dead Planet",
    "Vicious Triangle",
    "Lady of the West"
  ],

  INVITE_URL_PREFIX: process.env.SERVER_ROOT + "/join/",

  START_GAME_MANUAL_TIMEOUT: 3,
  START_GAME_AUTO_TIMEOUT: 5,

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

});