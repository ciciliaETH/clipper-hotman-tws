import requests
import time
import os

BASE_URL = os.environ.get('REFRESH_BASE_URL', 'https://your-deployment-url.com')
# Bisa langsung hardcode di sini jika mau, atau pakai env VPS
CRON_SECRET = os.environ.get('CRON_SECRET') or 'ISI_SECRET_KAMU_DI_SINI'

# List endpoint jobs to run (add more as needed)
ENDPOINTS = [
    '/api/cron/instagram-refresh',
    '/api/cron/backfill-accrual',
    # Tambahkan endpoint lain jika perlu
]

# Default params for batch endpoints
DEFAULT_LIMIT = 20
DEFAULT_CONCURRENCY = 4


def call_with_pagination(endpoint, params=None):
    params = params or {}
    offset = 0
    total = None
    while True:
        p = params.copy()
        p['limit'] = p.get('limit', DEFAULT_LIMIT)
        p['concurrency'] = p.get('concurrency', DEFAULT_CONCURRENCY)
        p['offset'] = offset
        url = BASE_URL.rstrip('/') + endpoint
        print(f'Calling: {url} offset={offset}')
        resp = requests.get(url, params=p, headers={'Authorization': f'Bearer {CRON_SECRET}'}, timeout=60)
        data = resp.json()
        print('Result:', data.get('message') or data)
        if data.get('done') or not data.get('results'):
            break
        offset = data.get('offset', offset + p['limit'])
        total = data.get('total', total)
        time.sleep(2)  # avoid rate limit
    print(f'Finished {endpoint} ({total or "?"} total)')


def call_simple_post(endpoint, payload=None):
    url = BASE_URL.rstrip('/') + endpoint
    print(f'POST: {url}')
    resp = requests.post(url, json=payload or {}, headers={'Authorization': f'Bearer {CRON_SECRET}'}, timeout=60)
    print('Result:', resp.text)


def main():
    # Instagram refresh (batched)
    call_with_pagination('/api/cron/instagram-refresh')
    # Backfill accrual (POST)
    call_simple_post('/api/cron/backfill-accrual', {'days': 28})
    # Tambahkan pemanggilan endpoint lain sesuai kebutuhan

if __name__ == '__main__':
    main()
