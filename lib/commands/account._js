/**
* Copyright (c) Microsoft.  All rights reserved.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var fs = require('fs');
var path = require('path');
var util = require('util');
var url = require('url');
var xml2js = require('xml2js');
var util = require('util');

var interaction = require('../util/interaction');
var utils = require('../util/utils');
var pfx2pem = require('../util/certificates/pkcs').pfx2pem;
var keyFiles = require('../util/keyFiles');
var cacheUtils = require('../util/cacheUtils');

exports.init = function (cli) {
  var $ = cli.getLocaleString;

  var log = cli.output;
  var azureDirectory = utils.azureDir();
  var pemPath = path.join(azureDirectory, 'managementCertificate.pem');
  var publishSettingsFilePath = path.join(azureDirectory, 'publishSettings.xml');

  var account = cli.category('account')
    .description($('Commands to manage your account information and publish settings'));

  account.command('download')
    .description($('Launch a browser to download your publishsettings file'))
    .option('-e, --environment <environment>', $('the publish settings download environment'))
    .option('-r, --realm <realm>', $('the organization\'s realm'))
    .execute(function (options, callback) {
      try {
        var url = cli.environmentManager.getPublishingProfileUrl(options.realm, options.environment);
        interaction.launchBrowser(url);
        log.help($('Save the downloaded file, then execute the command'));
        log.help('  account import <file>');
        callback();
      }
      catch (err) {
        callback(err);
      }
    });

  account.command('list')
    .description($('List the imported subscriptions'))
    .execute(function () {
      var cfg = account.readConfig();
      var subscriptions = account.readSubscriptions();
      log.table(subscriptions, function (row, s) {
        row.cell($('Name'), s.Name);
        row.cell($('Id'), s.Id);
        row.cell($('Current'), s.Id === cfg.subscription);
      });
    });

  account.command('set <subscription>')
    .description($('Set the current subscription'))
    .execute(function (subscription) {
      var subscriptions = account.readSubscriptions();

      // Try to match based on name first
      var importByName = true;
      var filtered = subscriptions.filter(function (s) { return utils.ignoreCaseEquals(s.Name, subscription); });
      if (!filtered.length) {
        // If nothing was found try matching on Id
        importByName = false;
        filtered = subscriptions.filter(function (s) { return utils.ignoreCaseEquals(s.Id, subscription); });

        if (!filtered.length) {
          // if still nothing found, just throw
          throw new Error(util.format($('Invalid subscription "%s"'), subscription));
        }
      }

      var subscriptionObject = filtered[0];
      var subscriptionTag = importByName ? subscriptionObject.Name : subscriptionObject.Id;
      log.info(util.format($('Setting subscription to "%s"'), subscriptionTag));

      setSubscription(subscriptionObject.Id);

      log.info($('Changes saved'));
    });

  account.command('import <file>')
    .description($('Import a publishsettings file or certificate for your account'))
    .option('--skipregister', $('skip registering resources'))
    .execute(function (file, options, callback) {
      log.verbose(util.format($('Importing file %s'), file));

      // Is it a .pem file?
      var keyCertValues = keyFiles.readFromFile(file);
      var keyPresent = !!keyCertValues.key;
      var certPresent = !!keyCertValues.cert;
      var publishSettings = null;
      if (keyPresent + certPresent === 1) {
        // Exactly one of them present.  Tell the user about the error.
        // Do not try this file as xml or pfx
        callback(util.format($('File %s needs to contain both private key and cert, but only %s was found'), file,
                (keyCertValues.key ? 'key' : 'certificate')));
      } else if (keyCertValues.key && keyCertValues.cert) {
        // Both key and cert are present.
        keyFiles.writeToFile(pemPath, keyCertValues);
        log.verbose(util.format($('Key and cert have been written to %s'), pemPath));
      } else {
        // Try to open as publishsettings or pfx.
        log.silly(util.format($('%s does not appear to be a PEM file. Reading as publish settings file'), file));
        var parser = new xml2js.Parser();
        parser.on('end', function (settings) { publishSettings = settings; });
        var readBuffer = fs.readFileSync(file);
        try {
          parser.parseString(readBuffer);
        } catch (err) {
          if (err.toString().indexOf($('Non-whitespace before first tag')) === -1) {
            // This looks like an xml parsing error, not PFX.
            callback(err);
          }

          log.silly($('Unable to read file as xml publish settings file. Assuming it is pfx'));
          publishSettings = null;
        }

        if (publishSettings) {
          processSettings(file, publishSettings);
        } else {
          convertPfx(readBuffer);
        }
      }

      cacheUtils.clear();
      if (!options.skipregister && publishSettings && publishSettings.PublishProfile.Subscription['@']) {
        var progress = cli.progress($('Verifying account'));
        return registerKnownResourceTypes(account.defaultSubscriptionId(), function (error) {
          progress.end();
          callback(error);
        });
      }

      return callback();

      function processSettings(file, settings) {
        if (!settings.PublishProfile ||
            !settings.PublishProfile['@'] ||
            (!settings.PublishProfile['@'].ManagementCertificate &&
             settings.PublishProfile['@'].SchemaVersion !== '2.0')) {
          throw new Error($('Invalid publishSettings file. Use "azure account download" to download publishing credentials.'));
        }

        var attribs = settings.PublishProfile['@'];
        var subs = settings.PublishProfile.Subscription;
        if (typeof subs === 'undefined' || subs === undefined) {
          subs = [];
        } else if (typeof (subs[0]) === 'undefined') {
          subs = [subs];
        }

        if (subs.length === 0) {
          log.warning($('Importing profile with no subscriptions'));
        } else {
          for (var index in subs) {
            log.info(util.format($('Found subscription: %s'), subs[index]['@'].Name));
            log.verbose('  Id:', subs[index]['@'].Id);
          }
        }

        if (attribs.Url) {
          var endpointInfo = utils.validateEndpoint(attribs.Url);
          var config = account.readConfig();
          config.endpoint = endpointInfo;
          account.writeConfig(config);
          log.info(util.format($('Setting service endpoint to: %s'), config.endpoint));
        }

        if (attribs.ManagementCertificate) {
          log.verbose($('Parsing management certificate'));
          var pfx = new Buffer(attribs.ManagementCertificate, 'base64');
          convertPfx(pfx);
        }

        log.verbose(util.format($('Storing account information at %s'), publishSettingsFilePath));
        utils.writeFileSyncMode(publishSettingsFilePath, readBuffer); // folder already created by convertPfx()
        if (subs.length !== 0) {
          log.info(util.format($('Setting default subscription to: %s'), subs[0]['@'].Name));
          log.info($('Use "azure account set" to change to a different one'));

          setSubscription(subs[0]['@'].Id);
        }

        log.warn(util.format($('The "%s" file contains sensitive information'), file));
        log.warn($('Remember to delete it now that it has been imported'));
        log.info($('Account publish settings imported successfully'));
      }
    });

  account.command('clear')
    .description($('Remove any of the stored account info stored by import or config set'))
    .action(function () {
      function deleteIfExists(file, isDir) {
        if (utils.pathExistsSync(file)) {
          log.silly(util.format($('Removing %s'), file));
          (isDir ? fs.rmdirSync : fs.unlinkSync)(file);
          return true;
        } else {
          log.silly(util.format($('%s does not exist'), file));
        }
      }

      var isDeleted = deleteIfExists(pemPath);
      isDeleted = deleteIfExists(publishSettingsFilePath) || isDeleted; // in this order only
      isDeleted = account.clearConfig() || isDeleted;
      isDeleted = cacheUtils.clear() || isDeleted;
      try {
        deleteIfExists(azureDirectory, true);
      } catch (err) {
        log.warn(util.format($('Couldn\'t remove %s'), azureDirectory));
      }
      log.info(isDeleted ? $('Account settings cleared successfully')
          : $('Account settings are already clear'));
    });

  var affinityGroup = account.category('affinity-group')
    .description($('Commands to manage your Affinity Groups'));

  affinityGroup.command('list')
    .description($('List locations available for your account'))
    .option('-s, --subscription <id>', $('the subscription id'))
    .execute(function (options, callback) {
      listLAG('AffinityGroups', options, callback);
    });

  affinityGroup.command('create <name>')
    .description($('Create an affinity group'))
    .option('-s, --subscription <id>', $('the subscription id'))
    .option('-l, --location <name>', $('the data center location'))
    .option('-e, --label <label>', $('the affinity group label'))
    .option('-d, --description <description>', $('the affinity group description'))
    .execute(function (name, options, callback) {
      var channel = utils.createServiceManagementService(cli.category('account').lookupSubscriptionId(options.subscription),
          cli.category('account'), log);

      var affinityGroupOptions = {
        Label: options.label,
        Description: (typeof options.description === 'string' ? options.description : undefined),
        Location: options.location
      };

      var progress = cli.progress($('Creating affinity group'));
      utils.doServiceManagementOperation(channel, 'createAffinityGroup', name, affinityGroupOptions, function (error) {
        progress.end();

        callback(error);
      });
    });

  affinityGroup.command('show <name>')
    .description($('Show details about an affinity group'))
    .option('-s, --subscription <id>', $('the subscription id'))
    .execute(function (name, options, callback) {
      var channel = utils.createServiceManagementService(cli.category('account').lookupSubscriptionId(options.subscription),
          cli.category('account'), log);

      var progress = cli.progress($('Enumerating affinity groups'));
      utils.doServiceManagementOperation(channel, 'getAffinityGroup', name, function(error, response) {
        progress.end();
        if (!error) {
          delete response.body['@']; // skip @ xmlns and @ xmlns:i
          if (log.format().json) {
            log.json(response.body);
          } else {
            utils.logLineFormat(response.body, log.data);
          }
        }
        callback(error);
      });
    });

  affinityGroup.command('delete <name>')
    .description($('Delete an affinity group'))
    .option('-q, --quiet', $('quiet mode, do not ask for delete confirmation'))
    .option('-s, --subscription <id>', $('the subscription id'))
    .execute(function (name, options, _) {
      var channel = utils.createServiceManagementService(cli.category('account').lookupSubscriptionId(options.subscription),
          cli.category('account'), log);

      if (!options.quiet && !interaction.confirm(cli, util.format($('Delete affinity group %s? [y/n] '), name), _)) {
        return;
      }

      var progress = cli.progress($('Deleting affinity group'));
      try {
        utils.doServiceManagementOperation(channel, 'deleteAffinityGroup', name, _);
      } finally {
        progress.end();
      }
    });

  function listLAG(what, options, callback) {
    var channel = utils.createServiceManagementService(cli.category('account').lookupSubscriptionId(options.subscription),
      cli.category('account'), log);

    var textName = what.replace(/([A-Z])/g, ' $1').toLowerCase();
    var progress = cli.progress(util.format($('Enumerating %s'), textName));
    utils.doServiceManagementOperation(channel, 'list' + what, function (error, response) {
      progress.end();
      if (!error) {
        if (response.body.length > 0) {
          log.table(response.body, function (row, item) {
            if ('DisplayName' in item) { // for location
              row.cell('Name', item.DisplayName);
            } else {
              row.cell('Name', item.Name);
            }

            if ('Label' in item) {
              row.cell('Label', new Buffer(item.Label, 'base64').toString());
            }
            if ('Location' in item) {
              row.cell('Location', item.Location || '');
            }
          });
        } else {
          if (log.format().json) {
            log.json([]);
          } else {
            log.info('No' + textName + ' found');
          }
        }
      }
      callback(error);
    });
  }
  account.listLAG = listLAG;

  account.readPublishSettings = function () {
    var publishSettings = {};

    var parser = new xml2js.Parser();
    parser.on('end', function (result) { publishSettings = result; });
    try {
      log.silly(util.format($('Reading publish settings %s'), publishSettingsFilePath));
      var readBuffer = fs.readFileSync(publishSettingsFilePath);
      parser.parseString(readBuffer);
    } catch (err) {
      // publish settings file is not expected for all scenarios
    }

    return publishSettings;
  };

  function readSubscriptions () {
    if (!utils.pathExistsSync(publishSettingsFilePath)) {
      throw new Error($('No publish settings file found. Please use "azure account import" first'));
    }

    var parser = new xml2js.Parser();
    var publishSettings = null;
    parser.on('end', function (settings) { publishSettings = settings; });
    var readBuffer = fs.readFileSync(publishSettingsFilePath);

    try {
      parser.parseString(readBuffer);
    } catch (err) {
      if (err.toString().indexOf($('Non-whitespace before first tag')) === -1) {
        // This looks like an xml parsing error, not PFX.
        callback(err);
      }

      log.silly($('Unable to read file as xml publish settings file'));
      publishSettings = null;
    }

    if (publishSettings) {
      var subs = publishSettings.PublishProfile.Subscription;
      if (typeof subs === 'undefined' || subs === undefined) {
        subs = [];
      } else if (typeof (subs[0]) === 'undefined') {
        subs = [subs];
      }

      if (subs.length === 0) {
        log.warning($('No subscriptions'));
      } else {
        var subscriptions = [];
        for (var s in subs) {
          subscriptions[s] = subs[s]['@'];
        }

        return subscriptions;
      }
    } else {
      throw new Error($('Invalid publish settings file'));
    }
  }
  account.readSubscriptions = readSubscriptions;

  function setSubscription (id) {
    var subscriptions = readSubscriptions();
    var subscription = subscriptions.filter(function (subscription) {
      return subscription.Id === id;
    })[0];

    if (!subscription) {
      throw new Error(util.format($('Invalid subscription %s'), id));
    } else {
      var config = account.readConfig();

      if (subscription.ServiceManagementUrl && subscription.ServiceManagementUrl !== config.endpoint) {
        var endpointInfo = utils.validateEndpoint(subscription.ServiceManagementUrl);
        config.endpoint = endpointInfo;
        log.info(util.format($('Setting service endpoint to: %s'), config.endpoint));
      }

      if (subscription.ManagementCertificate) {
        log.verbose($('Parsing management certificate'));
        var pfx = new Buffer(subscription.ManagementCertificate, 'base64');
        convertPfx(pfx);
      }

      config.subscription = id;
      account.writeConfig(config);
    }
  }
  account.setSubscription = setSubscription;

  function convertPfx(pfx) {
    var pem = pfx2pem(pfx);
    utils.writeFileSyncMode(pemPath, pem.toString(), 'utf8');
    log.verbose(util.format($('Converted PFX data to %s'), pemPath));
  }

  account.defaultSubscriptionId = function () {
    return account.readConfig().subscription;
  };

  account.lookupSubscriptionId = function (subscription) {
    // use default subscription if not passed as an argument
    if (subscription === undefined) {
      subscription = account.readConfig().subscription;
    }

    // load and normalize publish settings
    var publishSettings = account.readPublishSettings();

    if (publishSettings && publishSettings.PublishProfile) {
      var subs = publishSettings.PublishProfile.Subscription;
      if (subs === 'undefined') {
        subs = [];
      } else if (typeof (subs[0]) === 'undefined') {
        subs = [subs];
      }

      // use subscription id when the subscription name matches
      for (var index in subs) {
        if (subs[index]['@'].Name === subscription) {
          return subs[index]['@'].Id;
        }
      }
    }

    return subscription;
  };

  account.managementCertificate = function () {
    var pemFile = path.join(utils.azureDir(), 'managementCertificate.pem');
    log.silly(util.format($('Reading pem %s'), pemFile));
    return keyFiles.readFromFile(pemFile);
  };

  account.managementEndpointUrl = function () {
    var cfg = account.readConfig();

    var changes = false;

    // check if it is the configuration format used 
    // by version <= 0.6.0 and if so fix-up
    if (cfg.port) {
      cfg.endpoint = url.format({
        protocol: 'https',
        hostname: cfg.endpoint,
        port: cfg.port
      });

      delete cfg.port;

      changes = true;
    }

    // Check if there is a value for Subscription (caps) and
    // if so fix-up by deleting it
    if (cfg.Subscription) {
      delete cfg.Subscription;

      changes = true;
    }

    if (changes) {
      // Save fixed-up configuration
      account.writeConfig(cfg);
    }

    return cfg.endpoint;
  };

  // Dealing with registering resource providers on subscriptions

  var knownResourceTypes = [];
  var REQUIRED_API_VERSION = '2012-08-01';

  account.registerResourceType = function (resourceName) {
    log.silly(util.format($('Registering resource type %s'), resourceName));
    knownResourceTypes.push(resourceName);
  };

  account.knownResourceTypes = function () {
    return knownResourceTypes.slice(0);
  };

  function registerKnownResourceTypes(subscriptionId, callback) {
    var service = utils.createServiceManagementService(
      subscriptionId, account, log, REQUIRED_API_VERSION);

    function registerNextResource(resourceNames, errors, cb) {
      var errorString;
      if (resourceNames.length === 0) {
        log.verbose($('Resource registration on account complete'));
        if (errors.length > 0) {
          errorString = 'The following resources failed to register: ' + errors.join(',');
          // Ignore failing registrations for now, resource provider may not
          // exist. Update when we have a reliable way to detect this case.
          cb();
        } else {
          cb();
        }
      } else {
        log.verbose(util.format($('Registering resource type %s'), resourceNames[0]));
        service.registerResourceProvider(resourceNames[0], function (err) {
          if (err) {
            log.verbose(util.format($('Registration of resource type %s failed'), resourceNames[0]));
            errors.push(resourceNames[0]);
          }
          registerNextResource(resourceNames.slice(1), errors, cb);
        });
      }
    }

    function listResourceTypes(typesToList, validTypes, callback) {
      if (typesToList.length === 0) {
        return callback(null, validTypes);
      }

      service.listResourceTypes([typesToList[0]], function (err, resources) {
        if (err) {
          if (err.code === 'BadRequest' && err.message.search(/Service type\s+\S+\s+is invalid./) !== -1) {
            // Unknown resource type, just go on to the next one
            log.silly(util.format($('Listing resource type error: %s'), err.message));
            listResourceTypes(typesToList.slice(1), validTypes, callback);
          } else {
            // It's a real error, bail
            callback(err);
          }
        } else {
          validTypes.push(resources[0]);
          listResourceTypes(typesToList.slice(1), validTypes, callback);
        }
      });
    }

    listResourceTypes(knownResourceTypes, [], function (err, resources) {
      if (err) {
        return callback(err);
      }
      log.silly('Registered resource types = ', util.inspect(resources, false, null));
      var resourcesToRegister = resources
        .filter(function (r) { return r.state.toUpperCase() === 'UNREGISTERED'; })
        .map(function (r) { return r.type; });

      registerNextResource(resourcesToRegister, [], callback);

    });
  }
};