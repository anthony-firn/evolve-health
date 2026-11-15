"""End-to-end test in Chromium against a real storage node (no sample data, no mocks).

Rosa signs up, adds records and a node, invites Sam as a helper; Sam signs up from the invite,
they compare safety codes, Rosa approves; Sam records an appointment with a fake microphone;
Rosa plays it (fetched encrypted from the node), removes Sam, signs in on a second device with
her Emergency Kit, sends and withdraws a hosted pharmacy share, and imports records.

    pip install playwright && playwright install chromium
    python3 tests/browser_test.py [--shots DIR] [--fixtures DIR]

--fixtures may point at a folder with the SMART Health Cards example file
(example-00-e-file.smart-health-card) and an HL7 C-CDA example (ccd1.xml) to import as well.
"""
import argparse
import json
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PASS_ROSA = 'velvet-harbor-cocoa-meteor-tulip-zebra'
PASS_SAM = 'lantern-quartz-pebble-onion-violet-falcon'
CLIP = "navigator.clipboard.writeText = async (t) => { window.__copied = t; };"


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots')
    ap.add_argument('--fixtures')
    args = ap.parse_args()
    shots = Path(args.shots) if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    port = free_port()
    data = tempfile.mkdtemp(prefix='eh-e2e-')
    server = subprocess.Popen(['node', 'node/server.mjs', '--app', 'web', '--port', str(port), '--data', data], cwd=ROOT, stdout=subprocess.DEVNULL)
    base = f'http://localhost:{port}/'
    node = f'http://localhost:{port}'
    errors = []
    try:
        time.sleep(0.6)
        with sync_playwright() as p:
            flags = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
            try:  # system Chrome: Playwright's headless shell crashes on media and speech APIs
                browser = p.chromium.launch(channel='chrome', args=flags)
            except Exception:
                browser = p.chromium.launch(args=flags)

            def ctx(**kw):
                c = browser.new_context(viewport={'width': 1200, 'height': 900}, permissions=['microphone'], **kw)
                c.add_init_script(CLIP)
                return c

            def page_of(c, tag):
                pg = c.new_page()
                pg.on('pageerror', lambda e: errors.append(f'{tag}: {e}'))
                pg.on('console', lambda m: errors.append(f'{tag}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
                return pg

            def shot(pg, name):
                if shots:
                    pg.screenshot(path=str(shots / f'{name}.png'), full_page=True)

            def copied(pg):
                return pg.evaluate('window.__copied')

            def sync(pg):
                pg.goto(base + '#/settings/sync')
                pg.click('button:has-text("Sync now")')
                pg.wait_for_timeout(400)

            def sign_up(pg, name, pw):
                pg.click('text=Create your free vault')
                pg.fill('input[autocomplete=name]', name)
                pg.fill('input[autocomplete=new-password] >> nth=0', pw)
                pg.fill('input[autocomplete=new-password] >> nth=1', pw)
                pg.check('label.check.important input')
                pg.click('button:has-text("Create vault")')
                pg.wait_for_selector('text=Evolve Health Emergency Kit', timeout=60000)

            # ---- Rosa signs up and adds records ----
            a = ctx()
            rosa = page_of(a, 'rosa')
            rosa.goto(base)
            sign_up(rosa, 'Rosa', PASS_ROSA)
            shot(rosa, 'e2e-01-kit')
            rosa.click('text=I saved it, continue')
            rosa.fill('.form-grid input >> nth=0', 'Rosa Rivera')
            rosa.fill('input[type=date] >> nth=0', '1951-02-03')
            rosa.click('button:has-text("Add")')
            rosa.wait_for_selector('.emergency')
            rosa.select_option('.add-select', 'allergy')
            rosa.fill('input[placeholder="e.g. Penicillin"]', 'Sulfa drugs')
            rosa.fill('input[placeholder="e.g. Hives, swelling"]', 'Rash')
            rosa.click('button:has-text("Save")')
            rosa.wait_for_selector('h1:has-text("Sulfa drugs")')
            profile_url = rosa.url.split('/r/')[0]

            # ---- adds a node, invites Sam ----
            rosa.goto(base + '#/settings/sync')
            rosa.fill('input[type=url]', node)
            rosa.click('.field + button:has-text("Add"), button:has-text("Add") >> nth=0')
            rosa.wait_for_selector('text=Synced', timeout=15000)
            rosa.goto(base + '#/kit')
            rosa.click('text=Copy sign-in link')
            kit_link = copied(rosa)
            assert node in kit_link.replace('%3A', ':').replace('%2F', '/') or 'n=' in kit_link, kit_link
            rosa.goto(profile_url + '/access')
            rosa.fill('input[placeholder="e.g. Sam (my daughter)"]', 'Sam')
            rosa.click('text=Create invite link')
            rosa.click('button:has-text("Copy link")')
            invite = copied(rosa)
            assert '#invite=' in invite
            shot(rosa, 'e2e-02-invite')

            # ---- Sam accepts ----
            b = ctx()
            sam = page_of(b, 'sam')
            sam.goto(invite)
            sam.wait_for_selector('text=invited you to help')
            sign_up(sam, 'Sam', PASS_SAM)
            sam.click('text=I saved it, continue')
            sam.wait_for_selector('text=Help with Rosa Rivera')
            sam.click('button:has-text("Accept invite")')
            sam.wait_for_selector('.callout.ok, .toast.error', timeout=20000)
            assert sam.locator('text=Request sent').count() == 1, sam.inner_text('body')[:400]
            sam_code = sam.locator('.code-big').inner_text().strip()

            # ---- Rosa compares the safety code and approves ----
            sync(rosa)
            rosa.goto(base + '#/')
            rosa.wait_for_selector('text=Waiting for your approval')
            shown = rosa.locator('.request .mono').inner_text().strip()
            assert shown == sam_code, (shown, sam_code)
            shot(rosa, 'e2e-03-approve')
            rosa.click('button:has-text("Approve")')
            rosa.wait_for_selector('text=now has access')

            # ---- Sam sees Rosa's profile and records an appointment ----
            sync(sam)
            sam.goto(base + '#/')
            sam.wait_for_selector('.profile-card:has-text("Rosa Rivera")', timeout=15000)
            sam.click('.profile-card:has-text("Rosa Rivera")')
            expect(sam.locator('.emergency')).to_contain_text('Sulfa drugs')
            sam.click('text=Record an appointment')
            sam.check('.consent input[type=checkbox]')
            sam.click('button:has-text("Start recording")')
            sam.wait_for_selector('text=Mark a moment')
            sam.wait_for_timeout(1500)
            sam.click('.mark-buttons button:has-text("Medicine")')
            sam.wait_for_timeout(1500)
            shot(sam, 'e2e-04-recording')
            sam.click('button:has-text("Stop and save")')
            sam.wait_for_selector('.recording', timeout=15000)
            sam.click('.recording button:has-text("Play recording")')
            sam.wait_for_selector('.recording audio')
            shot(sam, 'e2e-05-visit')

            # ---- Rosa plays it (chunks fetched from the node), then removes Sam ----
            sync(sam)
            sync(rosa)
            rosa.goto(profile_url + '/k/visit')
            rosa.click('.row-link >> nth=0')
            rosa.wait_for_selector('.recording')
            assert 'Last changed by Sam' in rosa.inner_text('.record'), rosa.inner_text('.record')
            rosa.click('.recording button:has-text("Play recording")')
            rosa.wait_for_selector('.recording audio')
            duration = rosa.evaluate("new Promise(r => { const a = document.querySelector('.recording audio'); a.readyState >= 1 ? r(a.duration) : a.addEventListener('loadedmetadata', () => r(a.duration)); })")
            assert duration > 1, duration
            rosa.goto(profile_url + '/access')
            rosa.click('.member:has-text("Sam") button:has-text("Remove")')
            rosa.click('dialog button:has-text("Remove access")')
            rosa.wait_for_selector('text=no longer has access')
            sync(sam)
            sam.goto(base + '#/')
            sam.wait_for_timeout(500)
            assert sam.locator('.profile-card:has-text("Rosa Rivera")').count() == 0, 'Sam still sees the profile'

            # ---- Rosa on a second device, with the Emergency Kit ----
            c = ctx()
            laptop = page_of(c, 'laptop')
            laptop.goto(kit_link)
            laptop.wait_for_selector('text=Sign in with your Emergency Kit')
            laptop.fill('input[autocomplete=current-password]', PASS_ROSA)
            laptop.click('button:has-text("Sign in")')
            laptop.wait_for_selector('.profile-card:has-text("Rosa Rivera")', timeout=20000)
            laptop.click('.profile-card:has-text("Rosa Rivera")')
            expect(laptop.locator('.emergency')).to_contain_text('Sulfa drugs')

            # ---- hosted pharmacy share, opened by someone without an account, then withdrawn ----
            rosa.goto(profile_url + '/share')
            rosa.click('.preset:has-text("Pharmacy")')
            rosa.click('text=Next: review what to include')
            rosa.click('text=Next: how to send')
            expect(rosa.locator('.method:has-text("Link and QR code")')).to_contain_text('localhost')
            rosa.click('button:has-text("Create share")')
            rosa.wait_for_selector('.share-done')
            rosa.click('button:has-text("Copy link")')
            share_link = copied(rosa)
            assert '#n.' in share_link
            d = browser.new_context()
            pharmacist = page_of(d, 'pharmacy')
            pharmacist.goto(share_link)
            pharmacist.wait_for_selector('.viewer', timeout=15000)
            assert 'Sulfa drugs' in pharmacist.inner_text('.viewer')
            shot(pharmacist, 'e2e-06-pharmacy-view')
            rosa.goto(profile_url + '/shares')
            rosa.click('button:has-text("Opens")')
            expect(rosa.locator('.share-row').first).to_contain_text('Opened 1 time')
            rosa.click('button:has-text("Withdraw")')
            rosa.click('dialog button:has-text("Withdraw")')
            rosa.wait_for_selector('text=Withdrawn')
            pharmacist.reload()
            pharmacist.wait_for_selector('text=can’t be opened')

            # ---- imports ----
            if args.fixtures:
                fx = Path(args.fixtures)
                rosa.goto(profile_url + '/import')
                with rosa.expect_file_chooser() as fc:
                    rosa.click('button:has-text("Choose files")')
                fc.value.set_files([str(fx / 'example-00-e-file.smart-health-card'), str(fx / 'ccd1.xml')])
                rosa.wait_for_selector('text=Review the import')
                shot(rosa, 'e2e-07-import')
                rosa.click('button:has-text("Import ")')
                rosa.wait_for_selector('h1:has-text("Timeline")', timeout=20000)
                text = rosa.inner_text('.profile-main')
                assert 'COVID-19 (Moderna)' in text and 'Hemoglobin' in text, text[:400]

            browser.close()
    finally:
        server.terminate()
    real = [e for e in errors if 'net::ERR' not in e]
    if real:
        print('\n'.join(real))
        sys.exit(1)
    print('browser end-to-end: ok')


if __name__ == '__main__':
    main()
