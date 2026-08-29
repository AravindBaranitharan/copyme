#!/usr/bin/env bash
# Confirms the existing site on aravindbaranitharan.in is still healthy.
# Run before the nameserver switch to record a baseline, and after to compare.
set -u
DOMAIN=aravindbaranitharan.in

echo "nameservers"
dig +short NS "$DOMAIN" | sed 's/^/  /'
echo
echo "resolution"
printf "  apex -> %s\n" "$(dig +short A "$DOMAIN" | tr '\n' ' ')"
printf "  www  -> %s\n" "$(dig +short CNAME www."$DOMAIN" | tr '\n' ' ')"
echo
echo "reachability"
for host in "$DOMAIN" "www.$DOMAIN"; do
  read -r code server < <(curl -sS -o /tmp/_check.html -m 20 \
    -w "%{http_code} %{remote_ip}" "https://$host" 2>/dev/null || echo "000 -")
  printf "  %-32s HTTP %s  via %s\n" "$host" "$code" "$server"
done
echo
echo "content served at www"
printf "  bytes %s\n" "$(curl -sS -m 20 https://www.$DOMAIN | wc -c | tr -d ' ')"
printf "  sha   %s\n" "$(curl -sS -m 20 https://www.$DOMAIN | shasum -a 256 | cut -c1-16)"
echo
echo "verdict"
if curl -sSf -o /dev/null -m 20 "https://www.$DOMAIN" 2>/dev/null; then
  echo "  SITE IS UP"
else
  echo "  SITE IS DOWN — check that both DNS records are grey-cloud (DNS only)"
fi
