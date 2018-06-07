/*global module:false */

/*
 * The speaker object encapsulates the SoundManager2 code and boils it down
 * to the following api:
 *
 *    speaker().initializeAudio(): many clients can only start using
 *      speaker when handling an 'onClick' event. This call should be made 
 *      at that time to get audio initialized while waiting for details
 *      of what to play from the server. 
 *
 *    speaker().setVolume(value): set the volume from 0 (mute) - 100 (full volume)
 *
 *    var sound = speaker().create(url, optionsAndEvents): create a new sound from the
 *       given url and return a 'song' object that can be used to pause/play/
 *       destroy the song and receive trigger events as the song plays/stops. 
 *
 *       The 'optionsAndEvents' is an object that lets you specify event
 *       handlers and options:
 *
 *          startPosition:  specifies the time offset (in milliseconds) that the
 *                          sound should begin playback at when we begin playback.
 *          endPosition:    specifies the time offset (in milliseconds) that the
 *                          sound should stop playback 
 *          fadeInSeconds:  # of seconds to fade in audio
 *          fadeOutSeconds: # of seconds to fade out audio
 *          play:           event handler for 'play' event
 *          pause:          event handler for 'pause' event
 *          finish:         event handler for 'finish' event
 *          elapse:         event handler for 'elapse' event
 *
 *       The returned object emits the following events:
 *         play: the song has started playing or resumed playing after pause
 *         pause: the song has paused playback
 *         finish: the song has completed playback and the song object
 *           is no longer usable and should be destroyed
 *         elapse: song playback has elapsed
 *
 *       The events should be received in this order only:
 *         ( play -> ( pause | play )* -> )? finish
 *
 *       Note that I represent play failures as a 'finish' call, so if
 *       we can't load a song, it will just get a 'finish' and no 'play'.
 *       The 'finish' event will have a 'true' argument passed to it on
 *       some kind of error, so you can treat those differently.
 *
 *       The returned song object has this following api:
 *         play: start playback (at the 'startPosition', if specified)
 *         pause: pause playback
 *         resume: resume playback
 *         destroy: stop playback, prevent any future playback, and free up memory
 *
 * This module returns a function that returns a speaker singleton so everybody
 * is using the same instance.
 *
 * Proper usage looks like this:
 *
 *   require([ 'feed/speaker' ], function(speaker) {
 *     var mySpeaker = speaker(options, onReady);
 *   });
 *
 * That will make sure that all code uses the same speaker instance. 'options'
 * is optional, and is an object with any of the following keys:
 *
 *   debug: if true, emit debug information to the console
 *
 * 'onReady' is also optional, and is a callback that will be called as
 * soon as the sond system is initialized (or immediately if it was already
 * initialized) and it will be given a string that lists supported
 * audio formats, suitable for passing to Feed.Session.setFormats().
 *
 * The first function call to 'speaker()' is what configures and defines the
 * speaker - and subsequent calls just return the already-created instance.
 * I think this is a poor interface, but I don't have a better one at the
 * moment.
 *
 */

var _ = require('underscore');
var $ = require('jquery');
var log = require('./nolog');
var Events = require('./events');
var util = require('./util');
var version = require('./version');

var SILENCE ='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';


// fake console to redirect soundmanager2 to the feed logger
var feedConsole = {
  log: log,
  info: log,
  warn: log,
  error: log
};

var Sound = function(speaker, options, id, url) { 
  var obj = _.extend(this, Events);

  obj.id = id;
  obj.url = url;
  obj.speaker = speaker;
  obj.loaded = false;

  if (options) {
    this.startPosition = +options.startPosition;
    this.endPosition = +options.endPosition;

    this.fadeInSeconds = +options.fadeInSeconds;
    if (this.fadeInSeconds) {
      this.fadeInStart = this.startPosition ? (this.startPosition / 1000) : 0;
      this.fadeInEnd = this.fadeInStart + this.fadeInSeconds;
    } else {
      this.fadeInStart = 0;
      this.fadeInEnd = 0;
    }

    this.fadeOutSeconds = +options.fadeOutSeconds;
    if (this.fadeOutSeconds) {
      if (this.endPosition) {
        this.fadeOutStart = (this.endPosition / 1000) - this.fadeOutSeconds;
        this.fadeOutEnd = this.endPosition / 1000;
      } else {
        this.fadeOutStart = 0;
        this.fadeOutEnd = 0;
      }
    }

    _.each(['play', 'pause', 'finish', 'elapse'], function(ev) {
      if (ev in options) {
        obj.on(ev, options[ev]);
      }
    });

    this.gain = options.gain || 0;

  } else {
    this.gain = 0;

  }

  return obj;
};

function d(audio) {
  return ' src = ' + audio.src + ', time = ' + audio.currentTime + ', paused = ' + audio.paused + ', duration = ' + audio.duration + ', readyState = ' + audio.readyState;
}

Sound.prototype = {
  play: function() {
    log(this.id + ' sound play');
    return this.speaker._playSound(this);
  },

  // pause playback of the current sound clip
  pause: function() {
    log(this.id + ' sound pause');
    return this.speaker._pauseSound(this);
  },

  // resume playback of the current sound clip
  resume: function() {
    log(this.id + ' sound resume');
    return this.speaker._playSound(this);
  },

  // elapsed number of milliseconds played
  position: function() {
    //log(this.id + ' sound position');
    return this.speaker._position(this);
  },

  // duration in milliseconds of the song
  // (this may change until the song is full loaded)
  duration: function() {
    //log(this.id + ' sound duration');
    return this.speaker._duration(this);
  },

  // stop playing the given sound clip, unload it, and disable events
  destroy: function() {
    log(this.id + ' being called to destroy');
    this.speaker._destroySound(this);
  },

  gainAdjustedVolume: function(volume) {
    if (!this.gain) {
      log('no volume adjustment');
      return volume / 100;
    }

    var adjusted = Math.max(Math.min((volume / 100) * (50 * Math.pow(10, this.gain / 20)), 100), 0) / 100;

    //log('gain adjustment is ' + this.gain + ', and final adjusted volume is ' + adjusted);

    return adjusted;
  }

};

var Speaker = function(options) {
  var speaker = this;

  var aTest = document.createElement('audio');
  if (document.createElement('audio').canPlayType('audio/aac')) {
    this.preferred = 'aac,mp3';
  } else {
    this.preferred = 'mp3';
  }
};

Speaker.prototype = {
  vol: 100,  // 0..100
  outstandingPlays: { },

  activeAudio: null,  // Audio element that we play music with
  fadingAudio: null,  // Audio element that holds music fading out
  preparingAudio: null, // Audio element holding music we are queueing up

  prepareWhenReady: null, // url to prepare when active player is fully loaded

  activeSound: null,  // currently playing sound. when a sound finishes, it is removed from this
  fadingSound: null,   // currently fading out sound, if any

  initializeAudio: function() {
    // On mobile devices, we need to kick off playback of a sound in
    // response to a user event. This does that.
    if (!this.activeAudio) {
      log('initializing for mobile');

      this.activeAudio = new Audio(SILENCE);
      this._addEventListeners(this.activeAudio);
      this.activeAudio.loop = false;

      this.fadingAudio = new Audio(SILENCE);
      this._addEventListeners(this.fadingAudio);
      this.fadingAudio.loop = false;

      this.preparingAudio = this.prepareWhenReady ? new Audio(this.prepareWhenReady) : new Audio(SILENCE);
      this.prepareWhenReady = null;
      this._addEventListeners(this.preparingAudio);
      this.preparingAudio.loop = false;

    } else {
      log('mobile already initialized');
    }
  },

  _addEventListeners: function(audio) {
    audio.addEventListener('pause', _.bind(this._onAudioPauseEvent, this));
    audio.addEventListener('ended', _.bind(this._onAudioEndedEvent, this));
    audio.addEventListener('timeupdate', _.bind(this._onAudioTimeUpdateEvent, this));
    //this._debugAudioObject(audio);
  },

  _onAudioPauseEvent: function(event) {
    var audio = event.currentTarget;

    if (audio.src === SILENCE) {
      return;
    }

    if ((audio !== this.activeAudio) || (audio.currentTime === audio.duration)) {
      return;
    }

    if (!this.activeSound || (this.activeSound.url !== audio.src)) {
      log('active audio pause, but no matching sound');
      return;
    }

    this.activeSound.trigger('pause');
  },

  _onAudioEndedEvent: function(event) {
    var audio = event.currentTarget;

    if (audio.src === SILENCE) {
      return;
    }

    if (audio === this.fadingAudio) {
      audio.src = SILENCE;
      this.fadingSound = null;
      return;
    }

    if (audio !== this.activeAudio) {
      return;
    }

    if (!this.activeSound || (this.activeSound.url !== audio.src)) {
      log('active audio ended, but no matching sound', audio.src);
      return;
    }

    log('active audio ended');
    var sound = this.activeSound;
    this.activeSound = null;
    sound.trigger('finish');
  },

  _onAudioTimeUpdateEvent: function(event) {
    var audio = event.currentTarget;

    if (audio.src === SILENCE) {
      return;
    }

    if ((audio === this.fadingAudio) && this.fadingSound) {
      if (this.fadingSound.endPosition && (audio.currentTime >= (this.fadingSound.endPosition / 1000))) {
        this.fadingSound = null;
        this.fadingAudio.src = SILENCE;

      } else {
        this._setVolume(audio, this.fadingSound);
      }

      return;
    }

    if (audio !== this.activeAudio) {
      return;
    }

    if (!this.activeSound || (this.activeSound.url !== audio.src)) {
      log('active audio elapsed, but it no matching sound');
      return;
    }

    if (this.activeSound.endPosition && ((this.activeSound.endPosition / 1000) <= audio.currentTime)) {
      // song reached end of play
      var sound = this.activeSound;

      this.activeSound = null;

      this.activeAudio.src = SILENCE;

      sound.trigger('finish');

    } else if (this.activeSound.fadeOutEnd && (audio.currentTime >= this.activeSound.fadeOutStart)) {
      // song hit start of fade out
      this._setVolume(audio, this.activeSound);

      // swap it into 'fading' spot
      this.fadingSound = this.activeSound;
      this.activeSound = null;

      this.activeAudio = this.fadingAudio;
      this.fadingAudio = audio;

      // pretend the song finished
      this.fadingSound.trigger('finish');

    } else {
      this._setVolume(audio, this.activeSound);

      this.activeSound.trigger('elapse');
    }

    if (this.prepareWhenReady) {
      this.prepare(this.prepareWhenReady);
    }
  },

  _setVolume: function(audio, sound) {
    var currentTime = audio.currentTime;
    var currentVolume = audio.volume;
    var calculatedVolume = sound.gainAdjustedVolume(this.vol);

    //log('setting volume', { currentTime: currentTime, currentVolume: currentVolume, calculatedVolume: calculatedVolume, sound: sound });

    if ((sound.fadeInStart != sound.fadeInEnd) && (currentTime >= sound.fadeInStart) && (currentTime <= sound.fadeInEnd)) {
      // ramp up from 0 - 100%
      calculatedVolume = (currentTime - sound.fadeInStart) / (sound.fadeInEnd - sound.fadeInStart) * calculatedVolume;

    } else if ((sound.fadeOutStart != sound.fadeOutEnd) && (currentTime >= sound.fadeOutStart) && (currentTime <= sound.fadeOutEnd)) {
      // ramp down from 100% to 0
      calculatedVolume = (1 - (currentTime - sound.fadeOutStart) / (sound.fadeOutEnd - sound.fadeOutStart)) * calculatedVolume;

    }

    if (currentVolume != calculatedVolume) {
      log(audio.src + ' updating volume ' + ((currentVolume < calculatedVolume) ? '▲' : '▼') + ' to ' + calculatedVolume);
      audio.volume = calculatedVolume;
    }
  },

  _debugAudioObject: function(object) {
    var events = [ 'abort', 'load', 'loadend', 'loadstart', 'loadeddata', 'loadedmetadata', 'canplay', 'canplaythrough', 'seeked', 'seeking', 'stalled', 'timeupdate', 'volumechange', 'waiting', 'durationchange', 'progress', 'emptied', 'ended', 'play', 'pause'  ];
    var speaker = this;

    for (var i = 0; i < events.length; i++) {
      object.addEventListener(events[i], function(event) {
        var audio = event.currentTarget;
        var name = (audio === speaker.activeAudio) ?    'active' :
                   (audio === speaker.preparingAudio) ? 'preparing' :
                                           'fading';

        log(name + ': ' + event.type);
        log('    active: ' + d(speaker.activeAudio));
        log('    preparing: ' + d(speaker.preparingAudio));
        log('    fading: ' + d(speaker.fadingAudio));

        if (audio.src === SILENCE) {
          return;
        }
      });
    }
  },

  // Create and return new sound object. This throws the song into
  // the preparing audio instance.
  create: function(url, optionsAndCallbacks) {
    var id = _.uniqueId('feed-play-');
    var sound = new Sound(this, optionsAndCallbacks, id, url);

    log('created play ' + id + ' (' + url + ')', optionsAndCallbacks);

    this.outstandingPlays[sound.id] = sound;

    // start loading sound, if we can
    if (!this.activeAudio) {
      this.prepareWhenReady = sound.url;
    } else {
      this._prepare(sound.url, sound.startPosition);
    }

    return sound;
  },
  
  prepare: function(url) {
    if (!this.activeAudio) {
      this.prepareWhenReady = url;
      return;
    }

    var ranges = this.activeAudio.buffered;
    if ((ranges.length > 0) && (ranges.end(ranges.length - 1) >= this.activeAudio.duration)) {
      return this._prepare(url, 0);
    }

    if (this.activeAudio.url === SILENCE) {
      return this._prepare(url, 0);
    }

    // still loading primary audio - so hold off for now
    this.prepareWhenReady = url;
  },

  _prepare: function(url, startPosition) {
    // empty out any pending request
    this.prepareWhenReady = null;

    if (this.preparingAudio.src !== url) {
      log('preparing ' + url);
      this.preparingAudio.src = url;
    }

    if (startPosition && (this.preparingAudio.currentTime !== startPosition)) {
      log('advancing preparing audio to', startPosition / 1000);
      this.preparingAudio.currentTime = startPosition / 1000;
    }
  },

  /*
   * Kick off playback of the requested sound.
   */
  
  _playSound: function(sound) {
    var speaker = this;

    if (!this.activeAudio) {
      console.log('**** player.initializeAudio() *** not called');
      return;
    }

    if (this.activeSound === sound) {
      if (this.activeAudio.paused) {
        log(sound.id + ' was paused, so resuming');

        // resume playback
        this.activeAudio.play()
          .then(function() {
            log('resumed playback');
            sound.trigger('play');

        
          })
          .catch(function(error) { 
            log('error resuming playback');
            speaker.activeSound = null;
            sound.trigger('finish');
          });

        if (this.fadingSound) {
          this.fadingAudio.play()
            .then(function() {
              log('resumed fading playback');
          
            })
            .catch(function(error) { 
              log('error resuming fading playback');
              speaker.fadingSound = null;
              speaker.fadingAudio.src = SILENCE;
            });

        }

      } else {
        log(sound.id + ' is already playing');
      }

    } else {
      if (this.preparingAudio.src !== sound.url) {
        this._prepare(sound.url, sound.startPosition);
      }

      // move prepared sound into active player
      var oldActiveAudio = this.activeAudio;
      this.activeAudio = this.preparingAudio;
      this.preparingAudio = oldActiveAudio;

      this._setVolume(this.activeAudio, sound);
      this.preparingAudio.src = SILENCE;

      var existingSound = this.activeSound;
      this.activeSound = null;
      if (existingSound) {
        existingSound.trigger('finish');
      }

      log(sound.id + ' starting');
      this.activeAudio.play()
        .then(function() {
          log('success starting playback');
          speaker.activeSound = sound;

          // configure fade-out now that metadata is loaded
          if (sound.fadeOutSeconds && (sound.fadeOutEnd === 0)) {
            sound.fadeOutStart = speaker.activeAudio.duration - sound.fadeOutSeconds;
            sound.fadeOutEnd = speaker.activeAudio.duration;
          }

          var paused = speaker.activeAudio.paused;

          sound.trigger('play');

          if (paused) {
            sound.trigger('pause');
          }

        })
        .catch(function(error) {
          log('error starting playback', error);
          sound.trigger('finish', error);
        })
    }
  },

  _destroySound: function(sound) {
    log('want to destroy, and current is', sound, this.activeSound);
    sound.off();

    if (this.activeSound === sound) {
      log('destroy triggered for current sound', sound.id);
      this.activeAudio.pause();
    }

    delete speaker.outstandingPlays[this.id];
  },

  _pauseSound: function(sound) {
    if ((sound != null) && (sound !== this.activeSound)) {
      return;
    }

    this.activeAudio.pause();

    if (this.fadingSound) {
      this.fadingAudio.pause();
    }
  },

  _position: function(sound) {
    if (sound === this.activeSound) {
      if (sound.url !== this.activeAudio.src) {
        log('trying to get current song position, but it is not in the active audio player');
      }
      
      return this.activeAudio.currentTime;

    } else {
      return 0;

    }
  },

  _duration: function(sound) {
    if (sound === this.activeSound) {
      if (sound.url !== this.activeAudio.src) {
        log('trying to get current song duration, but it is not in the active audio player');
      }
      var d = this.activeAudio.duration;
      return isNaN(d) ? 0 : d;

    } else {
      return 0;

    }
  },

  // set the volume (0-100)
  setVolume: function(value) {
    if (typeof value !== 'undefined') {
      this.vol = value;

      if (this.activeSound) {
        this.activeAudio.volume = song.gainAdjustedVolume(value);
      }

      this.trigger('volume', value);
    }

    return this.vol;
  }

};

// add events to speaker class
_.extend(Speaker.prototype, Events);

var speaker = null;

// only export a single speaker
module.exports = function(options, onReady) {
  if (speaker === null) {
    speaker = new Speaker(options);
  }

  onReady(speaker.preferred);

  return speaker;
};

