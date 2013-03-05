var http = require('https'),
    url = require('url'),
    expat = require('node-expat'),
    jsonxml = require('jsontoxml'),
    util = require('util'),
    async = require('async'),
    moment = require('moment');

Object.defineProperty(Object.prototype, 'extend', {
    enumerable: false,
    value: function(from) {
        'use strict';
        var properties = Object.getOwnPropertyNames(from),
            dest = this;
        properties.forEach(function(name) {
            if (dest[name] !== undefined) {
                var destination = Object.getOwnPropertyDescriptor(from, name);
                Object.defineProperty(dest, name, destination);
            }
        });
        return dest;
    }
});

var memoize = function (func) {
    'use strict';
    var _cache = {};
    return function () {
        var args = Array.prototype.slice.call(arguments, 0),
            json = JSON.stringify(args), self = this;
        if ( ! _cache[json]) {
            _cache[json] = func.apply(self, args);
        }
        return _cache[json];
    };
};

var parseTag = memoize(function(nsName) {
    'use strict';
    var res = {}, parts = nsName.split(':');
    if (parts.length > 1) {
        res.ns = parts.shift();
    }
    res.name = parts.join(':');
    return res;
});


var httpCall = function(params, callback) {
    'use strict';
    var request, uri = url.parse(params.service.url),
        data = params.data,
        options = {
            host: uri.host,
            path: uri.path,
            method: (data ? 'POST' : 'GET'),
            headers: {
                'User-Agent': 'simple-soap-client/0.0.5',
                'Accept': '*/*',
                'Accept-Encoding': 'none',
                'Accept-Charset': 'utf-8',
                'SOAPAction': util.format('"urn:%s#%s"', params.service.name, params.action),
                'Content-type': 'text/xml'
            }
        };

    if (typeof data === 'string') {
        options.headers['Content-Length'] = data.length;
    }

    request = http.request(options, function(response) {
        var data = '';
        response.setEncoding('utf8');
        response.on('data', function(chunk) { data += chunk; });
        response.on('end', function() { callback(null, data); });
    });

    request.setTimeout(60000, function () { // Timeout on one minute of inactivity
        if (request) {
            request.abort();
            callback('Time out!');
        }
    });
    request.on('error', callback);
    request.end(data);
};

var parseResponse = function(data, callback) {
    'use strict';
    var p = new expat.Parser('UTF-8'), body = false,
        response = {}, current = false;

    p.on('startElement', function(nsName, attrs) {
        var tag, newElem, elem;
        if (nsName === 'SOAP-ENV:Body') {
            body = true; // We are inside the Body tag
        }
        if (body && current) { // If we are in the body, and there's a current element
            tag = parseTag(nsName);
            if (current[tag.name]) { // If there's already an element with the same tag name
                if ( ! (current[tag.name] instanceof Array)) {
                    current[tag.name] = [current[tag.name]]; // If the element is not an array, we convert it
                }
                newElem = {_parent: current}; // We create the new element with _parent pointing to the current one
                current[tag.name].push(newElem); // We add the new element to the current one
                current = newElem; // We change the current pointer to the new element
            } else {
                current[tag.name] = {_parent: current}; // If it's the only element with that tag, we add it and
                current = current[tag.name]; // We move the current pointer to the new element
            }
        } else if (body) {
            current = response; // We point current to the root response
        }
    });

    p.on('text', function(string) {
        current._val = string;  // text nodes are store as .value properties (if the element has other attributes)
    });

    p.on('endElement', function(name) {
        if (name === 'SOAP-ENV:Body') {
            body = false;
        }
        if (body) {
            var parent = current._parent;
            delete current._parent;
            current = parent;
        }
    });

    p.on('end', function() {
        callback(null, response);
    });

    if (!p.parse(data, false)) {
        callback(p.getError());
        return;
    }
    p.end();
};

var request = function(request, callback) {
    'use strict';
    var data = {}, envelope = '<SOAP-ENV:Envelope \n' +
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" \n' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" \n' +
        'xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" \n' +
        'SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" \n' +
        'xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"> \n' +
        '  <SOAP-ENV:Body> \n' +
        '    {body} \n' +
        '  </SOAP-ENV:Body> \n' +
        '</SOAP-ENV:Envelope>'
    ;

    data[request.action] = request['arguments'];
    request.data = envelope.replace('{body}', jsonxml.obj_to_xml(data));

    httpCall(request, function(error, data) {
        if (error) {
            return callback(error);
        }
        parseResponse(data, function(error, data) {
            if (error) {
                return callback(error);
            }
            callback(null, data);
        });
    });
};

var enforcedRequest = function(options, resultParser, callback) {
    'use strict';
    var parsed = false,
        count = 0,
        wait = 0
    ;

    options = {
        count: 60,
        soap: {},
        waitStart: 5000, //wait 5 seconds
        waitIncr: function (wait, count) {
            return Math.min(wait * 2, 60000); // Never wait for more than 1 minute
        },
        timeout: moment().add('minutes', 30) // timeout for the whole enforced request
    }.extend(options);

    wait = options.waitStart;

    async.until(
        function () {
            return parsed || count >= options.count || 0 > options.count;
        },
        function (callback) {
            request(options.soap,
                function(err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    if (options.timeout < moment()) {
                        return callback('Time out!');
                    }
                    resultParser(data, function (err, result) {
                        parsed = result;
                        if (err || ! parsed) {
                            setTimeout(callback, wait);
                            wait = options.waitIncr(wait, count);
                            count++;
                            return;
                        }
                        callback();
                    });
                }
            );
        },
        function (err) {
            if (err || !parsed) {
                return callback(err);
            }
            callback();
        }
    );
};

exports.request = request;
exports.enforcedRequest = enforcedRequest;
