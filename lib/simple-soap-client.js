var http = require('https'),
    url = require('url'),
    expat = require('node-expat'),
    jsonxml = require('jsontoxml'),
    util = require('util'),
    async = require('async'),
    moment = require('moment');


var _parseName = function(nsName) {
    var i;
    if ((i = nsName.indexOf(':')) < 0) return {name: nsName};
    else return {ns: nsName.substr(0,i), name: nsName.substr(i+1)}
}

var envelope = '<SOAP-ENV:Envelope \
xmlns:xsd="http://www.w3.org/2001/XMLSchema" \
xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" \
xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" \
SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" \
xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"> \
  <SOAP-ENV:Body> \
    {body} \
  </SOAP-ENV:Body> \
</SOAP-ENV:Envelope>';

Object.defineProperty(Object.prototype, "extend", {
    enumerable: false,
    value: function(from) {
        var props = Object.getOwnPropertyNames(from);
        var dest = this;
        props.forEach(function(name) {
            if (name in dest) {
                var destination = Object.getOwnPropertyDescriptor(from, name);
                Object.defineProperty(dest, name, destination);
            }
        });
        return this;
    }
});

var EnforcedRequest = function(options, resultParser, cb) {
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
        }
    }.extend(options);

    wait = options.waitStart;

    async.until(
        function () { 
            return parsed || count >= options.count || 0 > options.count;
        },
        function (callback) {

            Request(options.soap,
                function(err, data) {
                    if (err) return callback(err);
                    try {
                        parsed = resultParser(data);
                        if (parsed) {
                            process.nextTick(callback);
                        } else {
                            setTimeout(callback, wait);
                            wait = options.waitIncr(wait, count);
                        }
                        count++;
                    } catch(err) {
                        return callback(err);
                    }
                }
            );
        },
        function (err) {
            if (err || !parsed) cb(err);
            else cb(null, parsed)
        }
    );
}

var Request = function(request, callback) {
    var data = {};
    data[request.action] = request.arguments;
    request.data = envelope.replace('{body}', jsonxml.obj_to_xml(data));

    HttpCall(request, function(e, d) {
        if (e) process.nextTick(function() {
            callback(e)
        });
        ParseXML(d, function(e, d) {
            if (e) process.nextTick(function() {
                callback(e)
            });
            callback(null, d);
        });
    })
}

var ParseXML = function(d, callback) {
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
    })

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
    })

    p.on('end', function() {
        callback(null, response);
    })

    if (!p.parse(d, false)) {
        process.nextTick(function() {
            callback(p.getError())
        })
    }
    p.end();
}

var HttpCall = function(request, callback) {
    var uri = url.parse(request.service.url);
    var data = request.data;
    var method = data ? "POST" : "GET";
    var headers = {
        "User-Agent": "simple-soap-client/0.0.1",
        'Accept': '*/*',
        "Accept-Encoding": "none",
        "Accept-Charset": "utf-8",
        'SOAPAction': util.format('"urn:%s#%s"', request.service.name, request.action),
        'Content-type': 'text/xml',
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

    req = http.request(options, function(res) {
        var data = "";
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            data += chunk;
        });
        res.on('end', function() {
            process.nextTick(function() {
                callback(null, data);
            });
        })
    });

    req.on('error', function(e) {
        process.nextTick(function() {
            callback(e, null);
        });
    });
    req.end(data);
}

exports.Request = Request;
exports.EnforcedRequest = EnforcedRequest;