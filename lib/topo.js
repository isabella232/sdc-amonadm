/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var assert = require('assert-plus');
var once = require('once');

var Queue = require('./queue').Queue;



///--- Helpers

function get_vm_role(role_key, instance, service) {
    assert.string(role_key, 'role_key');
    assert.object(instance, 'instance');
    assert.object(service, 'service');

    if (instance.type) {
        assert.string(instance.type, 'instance.type');

        if (instance.type !== 'vm') {
            /*
             * We currently only support instances of the type "vm"; i.e.,
             * not agents, or any other type.
             */
            return (null);
        }
    }

    var get_role = function (o) {
        /*
         * Attempt to load the role from the tags in the SAPI object we were
         * passed:
         */
        if (o.params && o.params.tags) {
            assert.object(o.params.tags);

            var rk = o.params.tags[role_key];
            if (rk) {
                assert.string(rk);

                return (rk);
            }
        }

        return (null);
    };

    /*
     * Look for a role on the SAPI instance first.  If one is not found, fall
     * back to the SAPI service.
     */
    return (get_role(instance) || get_role(service) || null);
}

function build_index(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.instances, 'options.instances');
    assert.object(opts.vmapi, 'options.vmapi');
    assert.func(cb, 'callback');

    cb = once(cb);

    var obj = {
        roles: {},
        servers: {},
        zones: {}
    };
    var q = new Queue({
        limit: 10,
        worker: function (inst, _cb) {
            function _done() {
                if (!obj.servers[inst.cn])
                    obj.servers[inst.cn] = [];

                obj.servers[inst.cn].push(inst);
                _cb();
            }

            if (inst.cn) {
                _done();
                return;
            }

            opts.vmapi.getVm(inst, function (err, vm) {
                if (err) {
                    _cb(err);
                    return;
                }

                inst.cn = vm.server_uuid;
                _done();
            });
        }
    });

    // Get list of existing probes and populate instance.probe when a probe
    // already exists for a role-instance
    opts.amon.listProbes(opts.user, function (err, probes) {
        if (err) {
            cb(err);
            return;
        }
        // { <role>: {<> } }
        var _probes = {};
        (probes || []).forEach(function (p) {
            if (_probes[p.agent] === undefined) {
                _probes[p.agent] = [];
            }
            _probes[p.agent].push(p);
        });

        var role_key = opts.application.role_key || 'role';
        Object.keys(opts.instances).forEach(function (k) {
            opts.instances[k].forEach(function (i) {
                var role = get_vm_role(role_key, i,
                    opts.services[i.service_uuid]);

                if (!role)
                    return;

                var cn = i.params && i.params.server_uuid;
                var inst = {
                    cn: cn,
                    role: role,
                    uuid: i.uuid,
                    probes: _probes[i.uuid]
                };

                if (!obj.roles[role])
                    obj.roles[role] = [];
                if (!obj.zones[i.uuid])
                    obj.zones[i.uuid] = [];

                obj.roles[role].push(inst);
                obj.zones[i.uuid].push(inst);
                q.push(inst);
            });
        });

        q.once('error', cb);
        q.once('end', function () {
            cb(null, obj);
        });
        q.close();
    });
}



///--- API

function get_application(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.application, 'options.application');
    assert.object(opts.sapi, 'options.sapi');
    assert.optionalString(opts.application.name, 'options.application.name');
    assert.optionalString(opts.application.role_key,
        'options.application.role_key');
    assert.func(cb, 'callback');

    cb = once(cb);

    var params = {
        name: opts.application.name || 'sdc',
        include_master: true
    };
    opts.sapi.listApplications(params, function (err, apps) {
        if (err) {
            cb(err);
            return;
        }

        if ((apps || []).length < 1) {
            cb(new Error('SAPI found no application ' + opts.application.name));
            return;
        }

        opts.application.uuid = apps[0].uuid;
        cb();
    });
}


function get_instances(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.application, 'options.application');
    assert.object(opts.sapi, 'options.sapi');
    assert.optionalString(opts.application.name, 'options.application.name');
    assert.optionalString(opts.application.role_key,
        'options.application.role_key');
    assert.func(cb, 'callback');

    cb = once(cb);

    var params = {
        include_master: true
    };
    var uuid = opts.application.uuid;

    opts.sapi.getApplicationObjects(uuid, params, function (err, svcs) {
        if (err) {
            cb(err);
            return;
        }

        opts.instances = svcs.instances;
        opts.services = svcs.services;
        build_index(opts, function (err2, instances) {
            if (err2) {
                cb(err2);
                return;
            }

            var keys = Object.keys(instances);
            keys.sort();
            keys.forEach(function (k) {
                opts.application[k] = instances[k];
            });

            cb();
        });
    });
}


function load_application(opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.application, 'options.application');
    assert.object(opts.log, 'options.log');
    assert.object(opts.sapi, 'options.sapi');
    assert.optionalString(opts.application.name, 'options.application.name');
    assert.optionalString(opts.application.role_key,
        'options.application.role_key');
    assert.func(cb, 'callback');

    cb = once(cb);
    get_application(opts, function (err) {
        if (err) {
            cb(err);
            return;
        }

        get_instances(opts, function (err2) {
            if (err2) {
                cb(err2);
                return;
            }

            cb(null, opts.application);
        });
    });
}



///--- Exports

module.exports = {
    get_application: get_application,
    get_instances: get_instances,
    load_application: load_application
};
