# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.
from __future__ import absolute_import, print_function

import copy
import json
import os
import sys
import time

import mozinfo
from mozlog.commandline import setup_logging
from talos import utils, test
from talos.cmdline import parse_args


class ConfigurationError(Exception):
    pass


# Set places maintenance far in the future (the maximum time possible in an
# int32_t) to avoid it kicking in during tests. The maintenance can take a
# relatively long time which may cause unnecessary intermittents and slow
# things down. This, like many things, will stop working correctly in 2038.
FAR_IN_FUTURE = 2147483647

DEFAULTS = dict(
    # args to pass to browser
    extra_args='',
    buildid='testbuildid',
    init_url='getInfo.html',
    env={'NO_EM_RESTART': '1'},
    # base data for all tests
    basetest=dict(
        cycles=1,
        profile_path='${talos}/base_profile',
        responsiveness=False,
        gecko_profile=False,
        gecko_profile_interval=1,
        gecko_profile_entries=100000,
        resolution=1,
        mainthread=False,
        shutdown=False,
        timeout=3600,
        tpchrome=True,
        tpcycles=10,
        tpmozafterpaint=False,
        tphero=False,
        fnbpaint=False,
        firstpaint=False,
        format_pagename=True,
        userready=False,
        testeventmap=[],
        base_vs_ref=False,
        tppagecycles=1,
        tploadnocache=False,
        tpscrolltest=False,
        win_counters=[],
        w7_counters=[],
        linux_counters=[],
        mac_counters=[],
        xperf_counters=[],
        setup=None,
        cleanup=None,
        preferences={},
    ),
    # default preferences to run with
    # these are updated with --extraPrefs from the commandline
    # for extension scopes, see
    # see https://developer.mozilla.org/en/Installing_extensions
    preferences={
        'app.update.enabled': False,
        'browser.addon-watch.interval': -1,  # Deactivate add-on watching
        'browser.aboutHomeSnippets.updateUrl':
            'https://127.0.0.1/about-dummy/',
        'browser.bookmarks.max_backups': 0,
        'browser.cache.disk.smart_size.enabled': False,
        'browser.cache.disk.smart_size.first_run': False,
        'browser.chrome.dynamictoolbar': False,
        'browser.dom.window.dump.enabled': True,
        'browser.EULA.override': True,
        'browser.link.open_newwindow': 2,
        'browser.reader.detectedFirstArticle': True,
        'browser.shell.checkDefaultBrowser': False,
        'browser.warnOnQuit': False,
        'browser.tabs.remote.autostart': False,
        'dom.allow_scripts_to_close_windows': True,
        'dom.disable_open_during_load': False,
        'dom.disable_window_flip': True,
        'dom.disable_window_move_resize': True,
        'dom.max_chrome_script_run_time': 0,
        'dom.max_script_run_time': 0,
        'extensions.autoDisableScopes': 10,
        'extensions.checkCompatibility': False,
        'extensions.enabledScopes': 5,
        'extensions.update.notifyUser': False,
        'hangmonitor.timeout': 0,
        'network.proxy.http': 'localhost',
        'network.proxy.http_port': 80,
        'network.proxy.type': 1,
        # Bug 1383896 - reduces noise in tests
        'idle.lastDailyNotification': int(time.time()),
        # Bug 1445243 - reduces precision of tests
        'privacy.reduceTimerPrecision': False,
        'places.database.lastMaintenance': FAR_IN_FUTURE,
        'security.enable_java': False,
        'security.fileuri.strict_origin_policy': False,
        'dom.send_after_paint_to_content': True,
        'security.turn_off_all_security_so_that_viruses_can_'
        'take_over_this_computer': True,
        'browser.newtabpage.activity-stream.default.sites': '',
        'browser.newtabpage.activity-stream.telemetry': False,
        'browser.newtabpage.activity-stream.tippyTop.service.endpoint': '',
        'browser.newtabpage.activity-stream.feeds.section.topstories': False,
        'browser.newtabpage.activity-stream.feeds.snippets': False,
        'browser.safebrowsing.downloads.remote.url':
            'http://127.0.0.1/safebrowsing-dummy/downloads',
        'browser.safebrowsing.provider.google.gethashURL':
            'http://127.0.0.1/safebrowsing-dummy/gethash',
        'browser.safebrowsing.provider.google.updateURL':
            'http://127.0.0.1/safebrowsing-dummy/update',
        'browser.safebrowsing.provider.google4.gethashURL':
            'http://127.0.0.1/safebrowsing4-dummy/gethash',
        'browser.safebrowsing.provider.google4.updateURL':
            'http://127.0.0.1/safebrowsing4-dummy/update',
        'browser.safebrowsing.provider.mozilla.gethashURL':
            'http://127.0.0.1/safebrowsing-dummy/gethash',
        'browser.safebrowsing.provider.mozilla.updateURL':
            'http://127.0.0.1/safebrowsing-dummy/update',
        'privacy.trackingprotection.introURL':
            'http://127.0.0.1/trackingprotection/tour',
        'browser.safebrowsing.phishing.enabled': False,
        'browser.safebrowsing.malware.enabled': False,
        'browser.safebrowsing.blockedURIs.enabled': False,
        'browser.safebrowsing.downloads.enabled': False,
        'browser.safebrowsing.passwords.enabled': False,
        'plugins.flashBlock.enabled': False,
        'privacy.trackingprotection.annotate_channels': False,
        'privacy.trackingprotection.enabled': False,
        'privacy.trackingprotection.pbmode.enabled': False,
        'browser.search.isUS': True,
        'browser.search.countryCode': 'US',
        'browser.search.geoip.url': '',
        'browser.urlbar.userMadeSearchSuggestionsChoice': True,
        'extensions.update.url':
            'http://127.0.0.1/extensions-dummy/updateURL',
        'extensions.update.background.url':
            'http://127.0.0.1/extensions-dummy/updateBackgroundURL',
        'extensions.blocklist.enabled': False,
        'extensions.blocklist.url':
            'http://127.0.0.1/extensions-dummy/blocklistURL',
        'extensions.hotfix.url':
            'http://127.0.0.1/extensions-dummy/hotfixURL',
        'extensions.update.enabled': False,
        'extensions.webservice.discoverURL':
            'http://127.0.0.1/extensions-dummy/discoveryURL',
        'extensions.getAddons.get.url':
            'http://127.0.0.1/extensions-dummy/repositoryGetURL',
        'extensions.getAddons.getWithPerformance.url':
            'http://127.0.0.1/extensions-dummy'
            '/repositoryGetWithPerformanceURL',
        'extensions.getAddons.search.browseURL':
            'http://127.0.0.1/extensions-dummy/repositoryBrowseURL',
        'media.gmp-manager.url':
            'http://127.0.0.1/gmpmanager-dummy/update.xml',
        'media.gmp-manager.updateEnabled': False,
        'extensions.systemAddon.update.url':
            'http://127.0.0.1/dummy-system-addons.xml',
        'app.normandy.api_url':
            'https://127.0.0.1/selfsupport-dummy/',
        'browser.ping-centre.staging.endpoint':
            'https://127.0.0.1/pingcentre/dummy/',
        'browser.ping-centre.production.endpoint':
            'https://127.0.0.1/pingcentre/dummy/',
        'media.navigator.enabled': True,
        'media.peerconnection.enabled': True,
        'media.navigator.permission.disabled': True,
        'media.capturestream_hints.enabled': True,
        'browser.contentHandlers.types.0.uri': 'http://127.0.0.1/rss?url=%s',
        'browser.contentHandlers.types.1.uri': 'http://127.0.0.1/rss?url=%s',
        'browser.contentHandlers.types.2.uri': 'http://127.0.0.1/rss?url=%s',
        'browser.contentHandlers.types.3.uri': 'http://127.0.0.1/rss?url=%s',
        'browser.contentHandlers.types.4.uri': 'http://127.0.0.1/rss?url=%s',
        'browser.contentHandlers.types.5.uri': 'http://127.0.0.1/rss?url=%s',
        'identity.fxaccounts.auth.uri': 'https://127.0.0.1/fxa-dummy/',
        'datareporting.healthreport.documentServerURI':
            'http://127.0.0.1/healthreport/',
        'datareporting.policy.dataSubmissionPolicyBypassNotification': True,
        'general.useragent.updates.enabled': False,
        'browser.webapps.checkForUpdates': 0,
        'browser.search.geoSpecificDefaults': False,
        'browser.snippets.enabled': False,
        'browser.snippets.syncPromo.enabled': False,
        'toolkit.telemetry.server': 'https://127.0.0.1/telemetry-dummy/',
        'experiments.manifest.uri':
            'https://127.0.0.1/experiments-dummy/manifest',
        'network.http.speculative-parallel-limit': 0,
        'lightweightThemes.selectedThemeID': "",
        'devtools.chrome.enabled': False,
        'devtools.debugger.remote-enabled': False,
        'devtools.theme': "light",
        'devtools.timeline.enabled': False,
        'identity.fxaccounts.migrateToDevEdition': False,
        'plugin.state.flash': 0,
        'media.libavcodec.allow-obsolete': True,
        'extensions.legacy.enabled': True,
        'xpinstall.signatures.required': False,
    }
)


# keys to generated self.config that are global overrides to tests
GLOBAL_OVERRIDES = (
    'cycles',
    'gecko_profile',
    'gecko_profile_interval',
    'gecko_profile_entries',
    'tpcycles',
    'tppagecycles',
    'tpmanifest',
    'tptimeout',
    'tpmozafterpaint',
    'tphero',
    'fnbpaint',
    'firstpaint',
    'userready',
)


CONF_VALIDATORS = []


def validator(func):
    """
    A decorator that register configuration validators to execute against the
    configuration.

    They will be executed in the order of declaration.
    """
    CONF_VALIDATORS.append(func)
    return func


def convert_url(config, url):
    webserver = config['webserver']
    if not webserver:
        return url

    if '://' in url:
        # assume a fully qualified url
        return url

    if '.html' in url:
        url = 'http://%s/%s' % (webserver, url)

    return url


@validator
def fix_xperf(config):
    # BBB: remove doubly-quoted xperf values from command line
    # (needed for buildbot)
    # https://bugzilla.mozilla.org/show_bug.cgi?id=704654#c43
    if config['xperf_path']:
        xperf_path = config['xperf_path']
        quotes = ('"', "'")
        for quote in quotes:
            if xperf_path.startswith(quote) and xperf_path.endswith(quote):
                config['xperf_path'] = xperf_path[1:-1]
                break
        if not os.path.exists(config['xperf_path']):
            raise ConfigurationError(
                "xperf.exe cannot be found at the path specified")


@validator
def set_webserver(config):
    # pick a free port
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('', 0))
    port = sock.getsockname()[1]
    sock.close()

    config['webserver'] = 'localhost:%d' % port


@validator
def update_prefs(config):
    config['preferences']['browser.tabs.remote.autostart'] = True
    # update prefs from command line
    prefs = config.pop('extraPrefs')
    if prefs:
        for arg in prefs:
            k, v = arg.split('=', 1)
            config['preferences'][k] = utils.parse_pref(v)


@validator
def fix_init_url(config):
    if 'init_url' in config:
        config['init_url'] = convert_url(config, config['init_url'])


@validator
def determine_local_symbols_path(config):
    if 'symbols_path' not in config:
        return

    # use objdir/dist/crashreporter-symbols for symbolsPath if none provided
    if not config['symbols_path'] and \
       config['develop'] and \
       'MOZ_DEVELOPER_OBJ_DIR' in os.environ:
        config['symbols_path'] = os.path.join(os.environ['MOZ_DEVELOPER_OBJ_DIR'],
                                              'dist',
                                              'crashreporter-symbols')


def get_counters(config):
    counters = set()
    return counters


def get_active_tests(config):
    activeTests = config.pop('activeTests').strip().split(':')

    # on osx, ARES6 crashes about 50% of the time, bug 1437425
    if mozinfo.os not in ['linux', 'win'] and \
       'ARES6' in activeTests and \
       not config['develop']:
        activeTests.remove('ARES6')

    # ensure tests are available
    availableTests = test.test_dict()
    if not set(activeTests).issubset(availableTests):
        missing = [i for i in activeTests
                   if i not in availableTests]
        raise ConfigurationError("No definition found for test(s): %s"
                                 % missing)

    return activeTests


def get_global_overrides(config):
    global_overrides = {}
    for key in GLOBAL_OVERRIDES:
        # get global overrides for all tests
        value = config[key]
        if value is not None:
            global_overrides[key] = value
        if key != 'gecko_profile':
            config.pop(key)

    return global_overrides


def build_manifest(config, manifestName):
    # read manifest lines
    with open(manifestName, 'r') as fHandle:
        manifestLines = fHandle.readlines()

    # look for configuration data - right now just MotionMark
    tuning_data = {}
    if os.path.isfile(manifestName + '.json'):
        with open(manifestName + '.json', 'r') as f:
            tuning_data = json.load(f)

    # write modified manifest lines
    with open(manifestName + '.develop', 'w') as newHandle:
        for line in manifestLines:
            newline = line.replace('localhost', config['webserver'])
            newline = newline.replace('page_load_test', 'tests')

            if tuning_data:
                suite = ''
                test = ''
                # parse suite/test from: suite-name=HTMLsuite&test-name=CompositedTransforms
                parts = newline.split('&')
                for part in parts:
                    key_val = part.split('=')
                    if len(key_val) != 2:
                        continue

                    if key_val[0] == 'suite-name':
                        suite = key_val[1]
                    if key_val[0] == 'test-name':
                        test = key_val[1]

                if suite and test and tuning_data:
                    osver = mozinfo.os
                    if osver not in ['linux', 'win']:
                        osver = 'osx'
                    complexity = tuning_data[suite]['complexity'][test][osver]
                    newline = newline.replace('complexity=300', 'complexity=%s' % complexity)
            newHandle.write(newline)

    newManifestName = manifestName + '.develop'

    # return new manifest
    return newManifestName


def get_test(config, global_overrides, counters, test_instance):
    mozAfterPaint = getattr(test_instance, 'tpmozafterpaint', None)
    hero = getattr(test_instance, 'tphero', None)
    firstPaint = getattr(test_instance, 'firstpaint', None)
    userReady = getattr(test_instance, 'userready', None)
    firstNonBlankPaint = getattr(test_instance, 'fnbpaint', None)

    test_instance.update(**global_overrides)

    # update original value of mozAfterPaint, this could be 'false',
    # so check for None
    if mozAfterPaint is not None:
        test_instance.tpmozafterpaint = mozAfterPaint
    if firstNonBlankPaint is not None:
        test_instance.fnbpaint = firstNonBlankPaint
    if firstPaint is not None:
        test_instance.firstpaint = firstPaint
    if userReady is not None:
        test_instance.userready = userReady
    if hero is not None:
        test_instance.tphero = hero

    # fix up url
    url = getattr(test_instance, 'url', None)
    if url:
        test_instance.url = utils.interpolate(convert_url(config, url))

    # fix up tpmanifest
    tpmanifest = getattr(test_instance, 'tpmanifest', None)
    if tpmanifest:
        test_instance.tpmanifest = \
            build_manifest(config, utils.interpolate(tpmanifest))

    # add any counters
    if counters:
        keys = ('linux_counters', 'mac_counters',
                'win_counters', 'w7_counters', 'xperf_counters')
        for key in keys:
            if key not in test_instance.keys:
                # only populate attributes that will be output
                continue
            if not isinstance(getattr(test_instance, key, None), list):
                setattr(test_instance, key, [])
            _counters = getattr(test_instance, key)
            _counters.extend([counter for counter in counters
                              if counter not in _counters])
    return dict(test_instance.items())


@validator
def tests(config):
    counters = get_counters(config)
    global_overrides = get_global_overrides(config)
    activeTests = get_active_tests(config)
    test_dict = test.test_dict()

    tests = []
    for test_name in activeTests:
        test_class = test_dict[test_name]
        tests.append(get_test(config, global_overrides, counters,
                              test_class()))
    config['tests'] = tests


def get_browser_config(config):
    required = ('preferences', 'extensions', 'browser_path', 'browser_wait',
                'extra_args', 'buildid', 'env', 'init_url', 'webserver')
    optional = {'bcontroller_config': '${talos}/bcontroller.json',
                'branch_name': '',
                'child_process': 'plugin-container',
                'debug': False,
                'debugger': None,
                'debugger_args': None,
                'develop': False,
                'process': '',
                'framework': 'talos',
                'repository': None,
                'sourcestamp': None,
                'symbols_path': None,
                'test_timeout': 1200,
                'xperf_path': None,
                'error_filename': None,
                'no_upload_results': False,
                'stylothreads': 0,
                'subtests': None,
                }
    browser_config = dict(title=config['title'])
    browser_config.update(dict([(i, config[i]) for i in required]))
    browser_config.update(dict([(i, config.get(i, j))
                          for i, j in optional.items()]))
    return browser_config


def suites_conf():
    import json
    with open(os.path.join(os.path.dirname(utils.here),
                           'talos.json')) as f:
        return json.load(f)['suites']


def get_config(argv=None):
    argv = argv or sys.argv[1:]
    cli_opts = parse_args(argv=argv)
    if cli_opts.suite:
        # read the suite config, update the args
        try:
            suite_conf = suites_conf()[cli_opts.suite]
        except KeyError:
            raise ConfigurationError('No such suite: %r' % cli_opts.suite)
        argv += ['-a', ':'.join(suite_conf['tests'])]
        argv += suite_conf.get('talos_options', [])
        # args needs to be reparsed now
    elif not cli_opts.activeTests:
        raise ConfigurationError('--activeTests or --suite required!')

    cli_opts = parse_args(argv=argv)
    setup_logging("talos", cli_opts, {"tbpl": sys.stdout})
    config = copy.deepcopy(DEFAULTS)
    config.update(cli_opts.__dict__)
    for validate in CONF_VALIDATORS:
        validate(config)
    # remove None Values
    for k, v in config.items():
        if v is None:
            del config[k]
    return config


def get_configs(argv=None):
    config = get_config(argv=argv)
    browser_config = get_browser_config(config)
    return config, browser_config


if __name__ == '__main__':
    cfgs = get_configs()
    print(cfgs[0])
    print
    print(cfgs[1])
