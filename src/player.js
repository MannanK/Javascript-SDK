/*global module:false */
/*jshint camelcase:false */

var Session = require('./session');
var Speaker = require('./speaker');
var Events = require('./events');
var _ = require('underscore');
var log = require('./log');


var warn = log;

/*
 * changes from iOS:
 *   this starts in UNINITIALIZED mode, while iOS starts in READY_TO_PLAY.
 *   this goes into STALLED mode while we wait for a song to start playback.
 *   iOS throws songs into a player queue and watches when a song is
 *     advanced to the next one. in here, we start a song after the completion
 *     of the previous one.
 *   while in PLAYING or PAUSED mode, there is guaranteed to be a currentPlay value
 *   throws out play-started and play-completed rather than current item changed
 */

/**
 * @classdesc
 *
 * This class exports a high level API for simple
 * music playback. It uses the Session class to
 * repeatedly ask for music from the Feed.fm servers
 * and send them to Speaker objects
 *
 * After creating an instance of this class, a
 * call should be made to {@link Player#setCredentials}
 * to ask the Feed.fm servers if music
 * playback is granted.
 *
 * @constructor
 * @mixes Events
 * @param {object} [options] - configuration options. See also 
 *       all the options in {@link Speaker}, which are passed on
 *       from here.
 * @param {boolean} [options.debug=false] - if true, debug to console
 * @param {number}  [options.reportElapseIntervalInMS=30000] - how often to report elapsed playback, in milliseconds
 */

var Player = function(options) {
  options = options || { };

  this.session = new Session();

  // watch the session!
  this.session.on('session-available', this._onSessionAvailable, this);
  this.session.on('session-not-available', this._onSessionNotAvailable, this);
  this.session.on('active-station-did-change', this._onSessionActiveStationDidChange, this);
  this.session.on('current-play-did-change', this._onSessionCurrentPlayDidChange, this);
  this.session.on('next-play-available', this._onSessionNextPlayAvailable, this);
  this.session.on('discard-next-play', this._onSessionDiscardNextPlay, this);
  this.session.on('no-more-music', this._onSessionNoMoreMusic, this);
  this.session.on('skip-status-did-change', this._onSessionSkipStatusDidChange, this);
  this.session.on('unexpected-error', this._onSessionUnexpectedError, this);

  // add event handling
  _.extend(this, Events);

  var speakerOptions = {};
  _.each(['debug', 'swfBase', 'preferFlash', 'silence'], function(p) {
    if (options[p]) {
      speakerOptions[p] = options[p];
    }
  });

  // initialize and watch the speaker!
  this.speakerPromise = Speaker.getShared(speakerOptions);

  this._state = Player.PlaybackState.UNINITIALIZED;

  // how often to report elapsed playback
  this._reportElapseIntervalInMS = options.reportElapseIntervalInMS || 30000;
  this._elapseInterval = null;

  /**
   * map play id -> Sound .
   * @private
   */

  this._sounds = { };

  /**
   * Reference to most recently started sound
   * @private
   */

  this._playingSound = null;
};

/**
 * @returns {Player.PlaybackState} the state of the player
 */

Player.prototype.getState = function() {
  return this._state;
};

/**
 * Update the current state. This also triggers a
 * {@link Player#event:playback-state-did-change} event.
 *
 * @param {Player.PlaybackState} newState - new state for the player.
 * @param {string} [reason] - human readable reason for transition
 * @private
 */

Player.prototype._setState = function(newState, reason) {
  var player = this;

  if (reason) {
    reason = ' for reason "' + reason + '"';
  } else {
    reason = '';
  }

  if (newState === this._state) {
    log('ignoring state change to ' + this.stateAsString(newState) + reason);
    return;
  }

  var oldState = this._state;
  this._state = newState;

  log('transitioned from ' + this.stateAsString(oldState) + ' to ' +
      this.stateAsString(newState) + reason);

  this.trigger('playback-state-did-change', newState, oldState);

  // background timer to record elapsed playback
  if (newState !== Player.PlaybackState.PLAYING) {
    if (this._elapseInterval) {
      clearInterval(this._elapseInterval);
      this._elapseInterval = null;
    }
  } else {
    this._elapseInterval = setInterval(function() {
      player._onPlaybackElapsedInterval();
    }, this._reportElapseIntervalInMS);
  }

  if (newState === Player.PlaybackState.UNAVAILABLE) {
    this.trigger('player-not-available');

  } else if ((oldState === Player.PlaybackState.UNINITIALIZED) &&
             (newState === Player.PlaybackState.READY_TO_PLAY)) {
      this.trigger('player-available');

  }
};

Player.prototype.stateAsString = function(state) {
  var text = _.findKey(Player.PlaybackState, function(value) { return value === state; });

  return text;
};

/**
 * Possible playback state values
 *
 * @readonly
 * @enum {number}
 */

Player.PlaybackState =  {
  UNINITIALIZED: 0,
  UNAVAILABLE: 1,
  WAITING_FOR_ITEM: 2,
  READY_TO_PLAY: 3,
  PLAYING: 4,
  PAUSED: 5,
  STALLED: 6,
  REQUESTING_SKIP: 7
};


/**
 * Assign credentials to the player. This kicks off
 * communication with Feed.fm to see if this client is
 * cleared to play music. If and when the client is
 * cleared play music and the audio system is initialized,
 * the {@link Player#getState} will change to READY_TO_PLAY.
 * Otherwise the state will become UNAVAILABLE. Also,
 * a {@link Player#event:player-available}
 * or {@link Player#event:player-not-available} event
 * will be triggered. Note that there is no time limit
 * on this completing, so it could potentially take a
 * long time for the state change. 
 *
 * @param {string} token token value provided by Feed.fm
 * @param {string} secret secret value provided by Feed.fm
 */

Player.prototype.setCredentials = function(token, secret) {
  this.session.setCredentials(token, secret);
};


/**
 * Start loading music in the background so that a 
 * call to {@link Player#play} immediately starts music.
 */

Player.prototype.prepareToPlay = function() {
  if (this._state === Player.PlaybackState.READY_TO_PLAY) {
    this.session.requestNextPlay();
  }
};

/**
 * Stop playback, if any, and switch to the passed-in
 * station. A new song will be requested and playback
 * will start immediately.
 *
 * @param {string} stationId the id of the station to tune to
 */

Player.prototype.setStation = function(stationId) {
  if (this._state === Player.PlaybackState.PLAYING) {
    this.session.updatePlay(Math.floor(this._playingSound.position() / 1000));
  }
  this.session.setStation(stationId);
};

/**
 * Start or resume music playback. If an audio file is specified, then
 * the current station is changed to the station with that file (if
 * we're not in that station already) and that song is queued up and
 * playback begun.
 *
 * @param {string} [audio file id] - optional specific song to play.
 * @param {string} [station id] - optional id of station holding song
 */

Player.prototype.play = function(audioFileId, stationId) {
  var sound;

  if (audioFileId) {
    var foundFile = this.session.requestPlay(audioFileId, stationId);

    if (foundFile) {
      // make sure we start playback when the song is loaded
      this._setState(Player.PlaybackState.WAITING_FOR_ITEM, 'User requesting specific file');
    }

  } else if (this._state === Player.PlaybackState.READY_TO_PLAY) {
    var nextPlay = this.session.nextPlay;

    if (nextPlay === null) {
      this._setState(Player.PlaybackState.WAITING_FOR_ITEM, 'User wants to play, but no song queued up');
      this.session.requestNextPlay();
      return;

    } else {
    
      sound = this._sounds[nextPlay.id];

      if (sound === null) {
        sound = this._prepareSound(nextPlay);
        this._sounds[nextPlay.id] = sound;
      }

      this._setState(Player.PlaybackState.STALLED, 'User wants to play, we are waiting for it to start');
      sound.play();
    }

  } else if (this._state === Player.PlaybackState.PAUSED) {
    var currentPlay = this.session.currentPlay;

    if (!currentPlay) {
      warn('trying to resume, but there is no current play!');
      return;
    }

    sound = this._sounds[currentPlay.id];

    if (!sound) {
      warn('trying to resume, but there are no sounds associated with current play');
      return;
    }

    sound.resume();
  }
};

/**
 * Pause music playback.
 */

Player.prototype.pause = function() {
  if (this._state === Player.PlaybackState.PLAYING) {
    var currentPlay = this.session.currentPlay;

    if (currentPlay === null) {
      warn('Trying to pause song, but there is no current play');
      return;
    }

    var sound = this._sounds[currentPlay.id];
    if (!sound) {
      warn('Trying to pause song, but cannot find sound associated with play id ' + currentPlay.id);
      return;
    }

    sound.pause();
  }
};

/**
 * Try to skip the current song. This will cause the
 * current song to complete (and trigger a
 * {@link Player#event:play-completed}) and advance
 * to the next song, or it will trigger a 
 * {@link Player#event:skip-denied} event and the
 * current song will continue playing.
 */

Player.prototype.skip = function() {
  if (!this.session.canSkip) {
    this.trigger('skip-denied');
    return;
  }

  if ((this._state === Player.PlaybackState.PLAYING) ||
      (this._state === Player.PlaybackState.PAUSED)) {

    if (this._state === Player.PlaybackState.PLAYING) {
      this._reportElapsedTime();
    }

    this._setState(Player.PlaybackState.REQUESTING_SKIP, 'User requested skip');

    this.session.requestSkip();
  }
};

Player.prototype._reportElapsedTime = function() {
  var currentPlay = this.session.currentPlay;

  if (!currentPlay) {
    return;
  }

  if (!this._playingSound) {
    return;
  }

  if (this._playingSound._play.id !== currentPlay.id) {
    return;
  }
 
  this.session.updatePlay(Math.floor(this._playingSound.position() / 1000));
};

/**
 * Cancel any pending tasks, stop and destroy any pending
 * or playing songs. This object is unusable after
 * this call.
 */

Player.prototype.destroy = function() {
  var session = this.session;

  this.session = null;
  session.destroy();

  _.each(this._sounds, function(sound) {
    sound.destroy();
  });

  if (this._elapseInterval) {
    clearInterval(this._elapseInterval);
    this._elapseInterval = null;
  }
};


Player.prototype._onSessionAvailable = function() {
  var player = this;

  this.speakerPromise
    .then(function(speaker) {
      player.speaker = speaker;
      player._setState(Player.PlaybackState.READY_TO_PLAY, 'Session and speaker ready');
    })
    .fail(function() {
      player._setState(Player.PlaybackState.UNAVAILABLE, 'Speaker initialization failed');
    });
};

Player.prototype._onSessionNotAvailable = function() {
  this._setState(Player.PlaybackState.UNAVAILABLE, 'Unable to create a session');
};

Player.prototype._onSessionUnexpectedError = function(error) {
  this._setState(Player.PlaybackState.READY_TO_PLAY, 'Unexpected session error');

  this.trigger('unexpected-error', error);
};

Player.prototype._onSessionNoMoreMusic = function() {
  if ((this._state === Player.PlaybackState.READY_TO_PLAY) ||
      (this._state === Player.PlaybackState.WAITING_FOR_ITEM)) {

    this._setState(Player.PlaybackState.READY_TO_PLAY, 'Session says we ran out of music');
    this.trigger('no-more-music');
  } 

};

Player.prototype._onSessionNextPlayAvailable = function(nextPlay) {
  if ((this._state === Player.PlaybackState.READY_TO_PLAY) ||
      (this._state === Player.PlaybackState.PLAYING) ||
      (this._state === Player.PlaybackState.PAUSED) ||
      (this._state === Player.PlaybackState.WAITING_FOR_ITEM)) {

    // TODO: if we're PLAYING or PAUSED, we might want to wait to start
    // loading the next song until the currently playing song
    // is fully loaded. Alternatively, wait a couple seconds before
    // starting to create the song; code that would start playing this
    // sound is smart enough to make the sound if it isn't made already.
    // (maybe put start time in Sound so we know when the previous
    // one started loading?)

    var sound = this._sounds[nextPlay.id];
    if (sound) {
      warn('received duplicate next play available for play id ' + nextPlay.id);

    } else {
      sound = this._prepareSound(nextPlay);
      this._sounds[nextPlay.id] = sound;

      log('created sound (' + sound.id + ') for play ' + nextPlay.id + ' at url ' + nextPlay.audio_file.url);
    }

    if (this._state === Player.PlaybackState.WAITING_FOR_ITEM) {
      this._setState(Player.PlaybackState.STALLED, 'Item came in while waiting for it');
      sound.play();
    }
  }
};

Player.prototype._onSessionDiscardNextPlay = function(play) {
  var sound = this._sounds[play.id];

  if (sound) {
    delete this._sounds[play.id];
    sound.destroy();
  }
};

Player.prototype._onSessionSkipStatusDidChange = function(canSkip) {
  if (this._state === Player.PlaybackState.REQUESTING_SKIP) {
    if (canSkip === false) {
      var currentPlay = this.session.currentPlay;
      if (!currentPlay) {
        warn('no current play after failed skip!');
        return;
      }

      var sound = this._sounds[currentPlay.id];
      if (!sound) {
        warn('no sound associated with current play when trying to resume from failed skip!');
        return;
      }

      // make sure we're playing the song when we go back to
      // PLAYING state
      sound.play();

      this._setState(Player.PlaybackState.PLAYING);

      this.trigger('skip-failed');

    }
  }
};

Player.prototype._onSessionActiveStationDidChange = function(station) {
  if (this._state === Player.PlaybackState.WAITING_FOR_ITEM) {
    this.session.requestNextPlay();
  }

  this.trigger('active-station-did-change', station);
};

Player.prototype._onPlaybackElapsedInterval = function() {
  if (this._state !== Player.PlaybackState.PLAYING) {
    return;
  }

  var currentPlay = this.session && this.session.currentPlay;

  if (!currentPlay) {
    warn('playback elapsed and we are in PLAYING mode, but no current play!');
    return;
  }

  if (!this._playingSound) {
    warn('playback elapsed and we are in PLAYING mode, but no playing sound!');
    return;
  }

  if (this._playingSound._play.id !== currentPlay.id) {
    warn('playing sound does not match current play');
    return;
  }
 
  this.session.updatePlay(Math.floor(this._playingSound.position() / 1000));
};

Player.prototype._prepareSound = function(play) {
  var player = this;

  var sound = this.speaker.create(play.audio_file.url, {
    play: function() { 
      if (player._state === Player.PlaybackState.STALLED) {
        if (player.session.currentPlay) {
          warn('song started playback, but there is a current play already?');
          return;
        }

        if (player.session.nextPlay === null) {
          warn('sound for play ' + play.id + ' started, but player.sesion.nextPlay is null');
          return;
        }

        if (player.session.nextPlay.id !== play.id) {
          warn('sound for play ' + play.id + ' started, but ' + player.session.nextPlay.id + ' is scheduled next');
          return;
        }

        player.session.playStarted();

      } else if (player._state === Player.PlaybackState.PAUSED) {
        if (player.session.currentPlay.id !== play.id) {
          warn('sound for play ' + play.id + ' resumed, but ' + player.session.currentPlay.id + ' is the active play');
          return;
        }

        player._setState(Player.PlaybackState.PLAYING, 'Audio resumed playback');

      }
    },
    pause: function() { 
      if (player._state === Player.PlaybackState.PLAYING) {
        var currentPlay = player.session.currentPlay;

        if (!currentPlay) {
          warn('audio paused, but there is no current play');
          return;
        }

        if (currentPlay.id !== play.id) {
          warn('audio paused, but current play ' + currentPlay.id + ' does not matched paused sound for play ' + play.id);
          return;
        }

        player.session.updatePlay(Math.floor(sound.position() / 1000));

        player._setState(Player.PlaybackState.PAUSED, 'Audio paused');
      }
      
    },
    finish: function(dueToError) { 
      var currentPlay = player.session.currentPlay;

      if (!currentPlay) {
        warn('audio finished for (' + play.id + '), but there is no current play');
        return;
      }

      if (currentPlay.id !== play.id) {
        warn('audio finished, but current play ' + currentPlay.id + ' does not match finishing sound for play ' + play.id);
        return;
      }

      player.session.playCompleted(dueToError);
    },

    elapsed: function() { }
  });

  sound._play = play;

  return sound;
};

Player.prototype._onSessionCurrentPlayDidChange = function(currentPlay) {
  if (currentPlay !== null) {
    // keep track of actively playing song
    this._playingSound = this._sounds[currentPlay.id];

    if (!this._playingSound) {
      warn('playback started for play ' + currentPlay.id + ' but we have no reference to its sound');
    }

  } else if ((currentPlay === null) && (this._playingSound)) {
    // stop playing sound and remove refs to it
    delete this._sounds[this._playingSound._play.id];
    this._playingSound.destroy();
    this._playingSound = null;

  }

  if ((this._state === Player.PlaybackState.STALLED) && (currentPlay !== null)) {
    this._setState(Player.PlaybackState.PLAYING, 'Playback of play ' + currentPlay.id + ' began');
    this.trigger('play-started', currentPlay);

  } else if ((this._state === Player.PlaybackState.PLAYING) ||
             (this._state === Player.PlaybackState.REQUESTING_SKIP) ||
             (this._state === Player.PlaybackState.PAUSED) || 
             ((currentPlay === null) && (this._state === Player.PlaybackState.STALLED))) {
    if (currentPlay != null) {
      warn('current play set to non-null while in playing or requesting skip state');
      return;
      
    } else {
      this.trigger('play-completed');

      var nextPlay = this.session.nextPlay;

      if (!nextPlay) {
        this._setState(Player.PlaybackState.WAITING_FOR_ITEM, 'Play completed, and we are waiting for next play');

      } else {
        var sound = this._sounds[nextPlay.id];

        if (!sound) {
          // its possible we opted to not start loading the sound earlier, 
          // so here we kick that off
          sound = this._prepareSound(nextPlay);
          this._sounds[nextPlay.id] = sound;

          log('created sound (' + sound.id + ') for play ' + nextPlay.id + ' at url ' + nextPlay.audio_file.url);
        }

        this._setState(Player.PlaybackState.STALLED, 'advancing to next song');
        sound.play();
      }
    }

  }

};

/**
 * Return a list of stations the server wants us to
 * know about. These can be used for {@link Player#setStation}
 * calls, and if they have 'audio_file' properties,
 * you can retrieve a list of songs available in the
 * station.
 *
 * @return {Station[]} array of stations
 */

Player.prototype.getStations = function() {
  return this.session.stations || [ ];
};

/**
 * Return a station object with the requested name.
 *
 * @param {string} [name] - station name to look for or, if not
 *    specified, return the current station
 * @return {Station} station with the requested name, or undefined
 */

Player.prototype.getStation = function(name) {
  if (!name) {
    return this.session.activeStation;
  }

  return _.find(this.session.stations, function(station) {
    return (station.name === name);
  });
};

/**
 * Return false if the user absolutely cannot skip the current
 * song, and true otherwise.
 *
 * @return {boolean}
 */

Player.prototype.getCanSkip = function() {
  return this.session.canSkip;
};

/**
 * Return details about the song currently
 * playing or paused.
 *
 * @return {Play} current play, if one is playing/paused, or null
 */

Player.prototype.getCurrentPlay = function() {
  if ((this._state === Player.PlaybackState.PLAYING) ||
      (this._state === Player.PlaybackState.PAUSED)) {
    return this.session.currentPlay;

  } else {
    return null;

  }
};

/**
 * Tell the server that the user likes the current
 * (or specified) song.
 *
 * @param {string} [playId] id of play that the user likes,
 *      or the currently playing one if not specified
 */

Player.prototype.like = function(playId) {
  this.session.requestLike(playId);
};

/**
 * Tell the server that the user dislikes the current
 * (or specified) song.
 *
 * @param {string} [playId] id of play that the user dislikes,
 *      or the currently playing one if not specified
 */

Player.prototype.dislike = function(playId) {
  this.session.requestDislike(playId);
};

/**
 * Tell the server that the user neither likes nor dislikes the current
 * (or specified) song.
 *
 * @param {string} [playId] id of play that the user dislikes,
 *      or the currently playing one if not specified
 */

Player.prototype.unlike = function(playId) {
  this.session.requestUnlike(playId);
};


/**
 * This event signifies that this client may
 * play music. Instead of listening for this you could
 * watch the state of the player to see if it
 * becomes {@link Player.PlaybackState.READY_TO_PLAY}
 * after being {@link Player.PlaybackState.UNINITIALIZED}
 *
 * @event Player.player-available
 */

/**
 * This event announces that the current active station
 * has changed. The new station is passed as an argument.
 *
 * @event Player.active-station-did-change
 */

/**
 * This event signifies that this client may
 * _NOT_ play music. Instead of listening for this you could
 * watch the state of the player to see if it
 * becomes {@link Player.PlaybackState.UNAVAILABLE}
 *
 * @event Player.player-not-available
 */

/**
 * This event signifies that the state of the player
 * has changed. Listeners for this event will be given
 * the new and the old state value.
 *
 * @event Player.playback-state-did-change
 * @type {stateChangeCallback}
 */

/**
 * This event announces that the server can't
 * serve up any more music for this client in
 * this station, so playback has stopped.
 *
 * @event Player.no-more-music
 */

/**
 * This event announces that the given play
 * has begun playback
 *
 * @event Player.play-started
 */

/**
 * This event announces that whatever was
 * previously playing has now stopped
 * playback.
 *
 * @event Player.play-completed
 */

/**
 * This event announces that a skip request
 * was denied.
 *
 * @event Player.skip-denied
 */

/**
 * This event announces that we had an unexpected
 * response from the server. This value is just passed
 * on from the {@link Session#event:unexpected-error}
 * event. The player class will reset itself back
 * to the READY_TO_PLAY state and
 * then emit this so the user can be informed.
 *
 * @event Player.unexpected-error
 */

/**
 * This callback is passed two {@link Player.PlaybackState} 
 * vaules: the new value and then the old value.
 *
 * @callback stateChangeCallback
 * @param {Player.PlaybackState} newState - new state of player
 * @param {Player.PlaybackState} oldState - old state of player
 */

module.exports = Player;
