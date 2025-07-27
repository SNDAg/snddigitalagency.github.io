import re

max_local_length = 15
max_email_length = 35

local_pattern = re.compile(
    r"^"
    r"(?=.{1," + str(max_local_length) + r"}$)"
    r"(?![.])"
    r"(?!.*[.]{2})"
    r"[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?"  # שם משתמש עם אפשרות לנקודה אחת בלבד
    r"$"
)

def is_valid_domain_part(part):
    if len(part) > 10:  # ריככנו את המגבלה מ-4 ל-10
        return False
    if len(part) < 2:  # ריככנו את המגבלה מ-4 ל-10
        return False
    if not re.fullmatch(r'[A-Za-z0-9]+', part):
        return False
    if not re.search(r'[A-Za-z]', part):
        return False
    return True

def is_valid_domain(domain):
    parts = domain.split('.')
    if len(parts) > 3:
        return False
    if any(part.startswith('-') or part.endswith('-') for part in parts):
        return False
    for part in parts:
        if not is_valid_domain_part(part):
            return False
    return True

def is_valid_email(email, min_len=12, max_len=64):
    email = email.strip()
    if len(email) < min_len or len(email) > max_len:
        return False
    if '@' not in email:
        return False
    local, sep, domain = email.partition('@')
    if not local_pattern.match(local):
        return False
    if not is_valid_domain(domain):
        return False
    return True

with open('mail.txt', 'r', encoding='utf-8') as file:
    emails = file.readlines()

valid_emails = [email.strip() for email in emails if is_valid_email(email)]

with open('valid_emails.txt', 'w', encoding='utf-8') as outfile:
    for email in valid_emails:
        outfile.write(email + '\n')

print(f"Found and saved {len(valid_emails)} valid emails to valid_emails.txt")
