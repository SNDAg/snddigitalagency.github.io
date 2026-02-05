#!/usr/bin/env python3
import requests
import time
import random
import re
import sys
from datetime import datetime
from pathlib import Path
from collections import defaultdict


# =========================================================================
# ========== USER  Configurations  ========================================
# =========================================================================


DEFAULT_CITY = "krabi"

PLACE_TYPES = [
    'חומוס',
    'שקשוקה',
    'מסעדה',
    'חבד',
    'חב"ד',
    'ישראלי',
    'ישראלית',
    'כשר',
    'חלבי',
    'בשרי',
    'chabad'
]


## google queries:
TEMPLATES = [

    '{place} {city} @gmail.com',
    '{place} {city} @yahoo.com',
    ' {city} {place} email',
    # ' {place} {city} email',
      'inurl:contact {place} {city}',
     # '{place} {city} contact email',
      # '{place} {city} @gmail.com',
      # '{place} {city} @yahoo.com',
    #'inurl:contact {place} {city},'
    # 'inurl:contact {place} {city} ("@gmail.com" OR "@hotmail.com" OR "@yahoo.com")',
    # '{place} {city} email OR "contact"',
]

EXCLUDE_SITES = [
    "agoda.com",
    "booking.com",
    "hostels.com",
    "expedia.com",
    "tripadvisor.com",
    "airbnb.com",
    "agoda.com",
    "hotels.com",
    "trivago.com",
    "kayak.com",
    "orbitz.com",
    "priceline.com",
    "travelocity.com",
    "trip.com",
    "hotelplanner.com",
    "bookingholdings.com",
    "pdfcoffee.com",         
    "multipard.com",         
    "arabus.com"
]

# ============================================================


# ========== Configs  ========================================

API_KEYS = [

    # shahaf579@gmail.com + eden 
    "f5a61080d33b7a84baa9bdc55c9d12b493c7ad87f8f3890164f8d3644e20265f", 
    # snddigitalagency.com + my 
    "1595e8a64a4751f5888ddf7e9ac37695422c645bc4db9b816815b41bebbf5af1",
    # shahaf579+2@gmail.com + sivan 
    "95c859ae890d7f67b5f8023c46b276b4939f6ae834d7a7bc501365ec67a09d4c",
    # shahaf579+2@gmail.com + dad 
    "ee440ae17faf070ce94b561e78f60acf2b5f47f3cab7d4521aa91e6dc30b6dbc",  
        # snd4digital@gmail.com + mom 
    "5735b8307d6f5a7a6b26d245539d6dd28c26d476d204c956176fd5db669004f6",
]

BAD_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".pdf"]
BAD_PREFIXES = ["noreply@", "no-reply@", "donotreply@"]

SEARCH_LOCALES = [
    {"hl": "en", "gl": "us", "location": "New York, United States"},
]

#max number for the api is 100
RESULTS_PER_QUERY = 100

SLEEP_MIN, SLEEP_MAX = 1.2, 2.4
DATA_DIR = Path("data")
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:114.0) Gecko/20100101 Firefox/114.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:114.0) Gecko/20100101 Firefox/114.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
]


api_index = 0
swiched_api_key = 0
# ============================================

def normalize_email(email: str) -> str:
    e = email.strip().lower()
    if e.endswith('.'):
        e = e[:-1]
    idx = e.find('.com')
    if idx != -1 and len(e) > idx + 4 and e[idx+4] != '.':
        e = e[:idx+4]
    return e

def is_valid_email(email: str) -> bool:
    if any(email.endswith(sfx) for sfx in BAD_SUFFIXES):
        return False
    if any(email.startswith(pfx) for pfx in BAD_PREFIXES):
        return False
    return True

def extract_emails_from_text(text: str) -> set:
    raw = re.findall(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+", text)
    return {normalize_email(r) for r in raw if is_valid_email(normalize_email(r))}

def build_queries(city: str) -> list:
    exclude_str = " ".join([f"-site:{site}" for site in EXCLUDE_SITES])
    queries = [tpl.format(place=place, city=city) + " " + exclude_str for place in PLACE_TYPES for tpl in TEMPLATES]
    return list(dict.fromkeys(queries))


def fetch_results(query: str, locale: dict) -> list:
    global api_index, swiched_api_key 
    max_attempts = len(API_KEYS)
    attempt = 0

    while attempt < max_attempts:
        api_key = API_KEYS[api_index]
        params = {"engine": "google", "q": query, "api_key": api_key, "num": RESULTS_PER_QUERY, **locale}
        headers = {"User-Agent": random.choice(USER_AGENTS)}
        resp = requests.get("https://serpapi.com/search", params=params, headers=headers)

        if resp.status_code in (429, 500, 502, 503):
            print(f"[WARN] Server error {resp.status_code}. Switching key / retrying...")
            swiched_api_key += 1
            api_index = (api_index + 1) % len(API_KEYS)
            attempt += 1
            time.sleep(2)
            continue

        resp.raise_for_status()
        return resp.json().get("organic_results", [])

    print("[ERROR] All API keys were rate limited. Exiting.")
    sys.exit(1)


def process_and_save_emails(new_emails, collected, existing, email_file):
    from collections import defaultdict

    collected.update(new_emails)
    domain_map = defaultdict(list)
    for e in sorted(collected):
        domain = e.split('@')[-1]
        domain_map[domain].append(e)

    to_add = []
    for domain, emails in domain_map.items():
        for email in emails:
            if email not in existing:
                to_add.append(email)

    if to_add:
        with email_file.open("a", encoding="utf-8") as f:
            for e in to_add:
                f.write(e + "\n")
                existing.add(e)
        print(f"[+] Saved {len(to_add)} new emails")
        return True

    return False


def main():
    city = input(f"Enter city name (default '{DEFAULT_CITY}'): ").strip() or DEFAULT_CITY
    slug = city.replace(" ", "_").lower()
    dir_path = DATA_DIR / slug
    dir_path.mkdir(parents=True, exist_ok=True)
    email_file = dir_path / f"{slug}_emails.txt"

    if email_file.exists():
        existing = set(email_file.read_text(encoding="utf-8").splitlines())
    else:
        existing = set()

    queries = build_queries(city)
    total_search = 0
    total_page = 0
    collected = set()
    initial_count = len(existing) 

    for query in queries:
        for locale in SEARCH_LOCALES:
            total_search += 1
            print(f"[INFO] Searching '{query}' @ {locale['location']} ({total_search} out of {len(queries)*len(SEARCH_LOCALES)})")

            results = fetch_results(query, locale)

            for r in results:
                snippet = r.get("snippet", "").lower()
                link = r.get("link", "")
                if "@" not in snippet and "contact" not in link.lower():
                    continue

                text_block = snippet
                new_emails = extract_emails_from_text(text_block)
                process_and_save_emails(new_emails, collected, existing, email_file)

            time.sleep(random.uniform(SLEEP_MIN, SLEEP_MAX))

    print("\n🎉 Done!")
    print(f"Used SERP requests: {total_search}")
    if swiched_api_key > 0:
            print(f"{swiched_api_key} API-key swiches")
    print(f"New Emails: {len(existing) - initial_count}")
    print(f"Total Emails in file: {len(existing)}")
    


if __name__ == "__main__":
    main()

