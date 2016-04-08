/*global module:false */

/*! A Feed.fm joint: github.com/fuzz-radio/Javascript-SDK */

var Session = require('./session');
var Auth = require('./auth');
var Request = require('./request');
var Client = require('./client');

/*
var log = require('./log');
var PlayerView = require('./player-view');
var Player = require('./player');
var getSpeaker = require('./speaker');
*/

/**
 * Feed is the namespace through which you can access
 * the various classes.
 * 
 * @namespace
 * @property {Session} Session - ref to Session class
 */

var Feed = {
  Session: Session,

  Auth: Auth,
  Request: Request,
  Client: Client

//  Player: Player,
//  PlayerView: PlayerView,
//  log: log,

//  _getSpeaker: getSpeaker
};

module.exports = Feed;
