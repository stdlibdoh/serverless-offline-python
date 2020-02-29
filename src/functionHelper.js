'use strict';

const trimNewlines = require('trim-newlines');
const debugLog = require('./debugLog');
const fork = require('child_process').fork;
const _ = require('lodash');
const path = require('path');
const uuid = require('uuid/v4');
const utils = require('./utils');

const handlerCache = {};
const messageCallbacks = {};

function runProxyHandler(funOptions, options) {
  const spawn = require('child_process').spawn;
  
  return function (event, context) {
    let args = ['invoke', 'local', '-f', funOptions.funName];
    const stage = options.s || options.stage;
    if (stage) { args = args.concat(['-s', stage]); }

    const process = spawn('sls', args,
          { stdio: ['pipe', 'pipe', 'pipe'], shell: true, cwd: funOptions.servicePath });
    process.stdin.write(`${JSON.stringify(event)}\n`);
    process.stdin.end();
    let results = '';
    let hasDetectedJson = false;
    process.stdout.on('data', data => {
      let str = data.toString('utf8');
      if (hasDetectedJson) {
              // Assumes that all data after matching the start of the
              // JSON result is the rest of the context result.
        results += trimNewlines(str);
      }
      else {
              // Search for the start of the JSON result
              // https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-output-format
        const match = /{[\r\n]?\s*"isBase64Encoded"|{[\r\n]?\s*"statusCode"|{[\r\n]?\s*"headers"|{[\r\n]?\s*"body"|{[\r\n]?\s*"principalId"/.exec(str);
        if (match && match.index > -1) {
                  // The JSON result was in this chunk so slice it out
          hasDetectedJson = true;
          results += trimNewlines(str.slice(match.index));
          str = str.slice(0, match.index);
        }

        if (str.length > 0) {
                  // The data does not look like JSON and we have not
                  // detected the start of JSON, so write the
                  // output to the console instead.
          console.log('Proxy Handler could not detect JSON:', `\x1b[34m${str}\x1b[0m`);
        }
      }
    });
    process.stderr.on('data', data => {
      context.fail(data);
    });
    process.on('close', code => {
      if (code === 0) {
        try {
          context.succeed(JSON.parse(results));
        }
        catch (ex) {
          context.fail(results);
        }
      }
      else {
        context.succeed(code, results);
      }
    });
  };
}


module.exports = {
  getFunctionOptions(fun, funName, servicePath, serviceRuntime) {
    console.log(fun, funName, servicePath);
      // Split handler into method name and path i.e. handler.run
    const handlerFile = fun.handler.split('.')[0];
    const handlerName = fun.handler.split('/').pop().split('.')[1];

    return {
      funName,
      handlerName, // i.e. run
      handlerFile,
      handlerPath: `${servicePath}/${handlerFile}`,
      servicePath,
      funTimeout: (fun.timeout || 30) * 1000,
      babelOptions: ((fun.custom || {}).runtime || {}).babel,
      serviceRuntime,
    };
  },

  createExternalHandler(funOptions, options) {
    let handlerContext = handlerCache[funOptions.handlerPath];

    function handleFatal(error) {
      debugLog(`External handler receieved fatal error ${JSON.stringify(error)}`);
      handlerContext.inflight.forEach(id => messageCallbacks[id](error));
      handlerContext.inflight.clear();
      delete handlerCache[funOptions.handlerPath];
    }

    if (!handlerContext) {
      debugLog(`Loading external handler... (${funOptions.handlerPath})`);

      const helperPath = path.resolve(__dirname, 'ipcHelper.js');
      const ipcProcess = fork(helperPath, [funOptions.handlerPath], {
        env: _.omitBy(process.env, _.isUndefined),
        stdio: [0, 1, 2, 'ipc'],
      });
      handlerContext = { process: ipcProcess, inflight: new Set() };
      if (options.skipCacheInvalidation) {
        handlerCache[funOptions.handlerPath] = handlerContext;
      }

      ipcProcess.on('message', message => {
        debugLog(`External handler received message ${JSON.stringify(message)}`);
        if (message.id) {
          messageCallbacks[message.id](message.error, message.ret);
          handlerContext.inflight.delete(message.id);
          delete messageCallbacks[message.id];
        }
        else if (message.error) {
          // Handler died!
          handleFatal(message.error);
        }

        if (!options.skipCacheInvalidation) {
          handlerContext.process.kill();
          delete handlerCache[funOptions.handlerPath];
        }
      });

      ipcProcess.on('error', error => handleFatal(error));
      ipcProcess.on('exit', code => handleFatal(`Handler process exited with code ${code}`));
    }
    else {
      debugLog(`Using existing external handler for ${funOptions.handlerPath}`);
    }

    return (event, context, done) => {
      const id = uuid();
      messageCallbacks[id] = done;
      handlerContext.inflight.add(id);
      handlerContext.process.send({ id, name: funOptions.handlerName, event, context });
    };
  },

  // Create a function handler
  // The function handler is used to simulate Lambda functions
  createHandler(funOptions, options) {
    if (options.useSeparateProcesses) {
      return this.createExternalHandler(funOptions, options);
    }

    if (!options.skipCacheInvalidation) {
      debugLog('Invalidating cache...');

      for (const key in require.cache) {
        // Require cache invalidation, brutal and fragile.
        // Might cause errors, if so please submit an issue.
        if (!key.match('node_modules')) delete require.cache[key];
      }
    }

    let handler = null;
    if (utils.isProxyRuntime(funOptions.serviceRuntime)) {
      handler = runProxyHandler(funOptions, options);
    }
    else {
      debugLog(`Loading handler... (${funOptions.handlerPath})`);
      handler = require(funOptions.handlerPath)[funOptions.handlerName];
    }
    if (typeof handler !== 'function') {
      throw new Error(`Serverless-offline: handler for '${funOptions.funName}' is not a function`);
    }

    return handler;
  },
};
