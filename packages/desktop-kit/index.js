'use strict';

const desktop = require('./desktop-embed');
const { Placement } = require('./placement');

module.exports = { ...desktop, Placement };
