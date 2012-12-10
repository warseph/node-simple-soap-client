var http = require('https'),
    url = require('url'),
    expat = require('node-expat'),
    jsonxml = require('jsontoxml'),
    util = require('util'),
    async = require('async'),
    moment = require('moment')
;


var _parseName = function(nsName) {
    'use strict';
    var i = nsName.indexOf(':');
    if (i < 0) return {name: nsName};
    else return {ns: nsName.substr(0,i), name: nsName.substr(i+1)};
};

var envelope = '<SOAP-ENV:Envelope \n' +
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

Object.defineProperty(Object.prototype, "extend", {
    enumerable: false,
    value: function(from) {
        'use strict';

        var props = Object.getOwnPropertyNames(from),
            dest = this
        ;

        props.forEach(function(name) {
            if (name in dest) {
                var destination = Object.getOwnPropertyDescriptor(from, name);
                Object.defineProperty(dest, name, destination);
            }
        });
        return this;
    }
});

var request = function(request, callback) {
    'use strict';
    var data = {};
    data[request.action] = request['arguments'];
    request.data = envelope.replace('{body}', jsonxml.obj_to_xml(data));

    httpCall(request, function(error, data) {
        if (error) {
            callback(error);
            return;
        }
        parseXML(data, function(error, data) {
            if (error) {
                callback(error);
                return;
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
        timeout: moment().add('minutes', 30)
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
                        callback('Timed out!');
                    } else {
                        try {
                            parsed = resultParser(data);
                            if (parsed) {
                                callback();
                            } else {
                                setTimeout(callback, wait);
                                wait = options.waitIncr(wait, count);
                            }
                            count++;
                        } catch(err) {
                            callback(err);
                            return;
                        }
                    }
                }
            );
        },
        function (err) {
            if (err || !parsed) callback(err);
            else callback(null, parsed);
        }
    );
};

var parseXML = function(data, callback) {
    'use strict';
    var p = new expat.Parser('UTF-8');
    var body = false;
    var response = {}, current = false;

    p.on('startElement', function(nsName, attrs) {
        if (nsName == "SOAP-ENV:Body") {
            body = true;
        }
        if (body) {
            if (current) {
                if (current[_parseName(nsName).name]) {
                    if (! Array.isArray(current[_parseName(nsName).name])) {
                        current[_parseName(nsName).name] = [current[_parseName(nsName).name]];
                    }
                    var newElem = {_parent: current};
                    current[_parseName(nsName).name].push(newElem);
                    current = newElem;
                } else {
                    current = current[_parseName(nsName).name] = {_parent: current};
                }
            } else {
                current = response;
            }
        }
    });

    p.on('text', function(string) {
        current.val = string;
    });

    p.on('endElement', function(name) {
        if (name == "SOAP-ENV:Body") {
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

var httpCall = function(request, callback) {
    'use strict';
    var uri = url.parse(request.service.url);
    var data = request.data;
    var method = data ? "POST" : "GET";
    var headers = {
        "User-Agent": "simple-soap-client/0.0.4",
        'Accept': '*/*',
        "Accept-Encoding": "none",
        "Accept-Charset": "utf-8",
        'SOAPAction': util.format('"urn:%s#%s"', request.service.name, request.action),
        'Content-type': 'text/xml'
    };

    if (typeof data == 'string') {
        headers["Content-Length"] = data.length;
    }

    var options = {
        host: uri.host,
        path: uri.path,
        method: method,
        headers: headers
    };

    var req = http.request(options, function(res) {
        var data = "";
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            data += chunk;
        });
        res.on('end', function() {
            callback(null, data);
        });
    });

    req.on('error', function(e) {
        callback(e, null);
    });
    req.end(data);
};

exports.request = request;
exports.enforcedRequest = enforcedRequest;