#!/usr/bin/env bash
# Checks a deployed server end to end. Run on the server as root:
#     sudo bash /opt/omnistat/deploy/vps/smoke-test.sh [domain]
# Without a domain it tests http://127.0.0.1:8000 directly.
set -uo pipefail

DOMAIN="${1:-}"
BASE="http://127.0.0.1:8000"
[[ -n "$DOMAIN" ]] && BASE="https://$DOMAIN"
KEY="$(grep -E '^OMNISTAT_API_KEYS=' /etc/omnistat/omnistat.env | cut -d= -f2- | cut -d, -f1)"
FAIL=0

check() { # description, command...
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $desc"; else echo "FAIL  $desc"; FAIL=1; fi
}

post() { # path, json body
  curl -fsS -X POST "$BASE$1" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d "$2"
}

timed() { # label, command...
  local label="$1"; shift
  local start end
  start=$(date +%s.%N); "$@" >/dev/null 2>&1; end=$(date +%s.%N)
  awk -v s="$start" -v e="$end" -v l="$label" 'BEGIN { printf "  %s: %.1fs\n", l, e - s }'
}

health="$(curl -fsS "$BASE/health" 2>/dev/null || true)"
check "API answers /health"                      grep -q '"status":"ok"' <<<"$health"
check "R sandbox image ready (via /health)"       grep -q '"r":"ready"' <<<"$health"
check "Maths sandbox image ready (via /health)"   grep -q '"math":"ready"' <<<"$health"

check "Worker containers have no network" bash -c \
  '! docker run --rm --network none omnistat-math-worker python -c "import urllib.request as u; u.urlopen(\"http://example.com\", timeout=5)"'
check "Worker root filesystem is read-only" bash -c \
  '! docker run --rm --read-only --network none omnistat-math-worker python -c "open(\"/etc/pwn\",\"w\")"'

MATH='{"operation":"derivative","expression":"x^2 sin(x)"}'
ROWS='[{"bp":120,"arm":"A"},{"bp":125,"arm":"A"},{"bp":118,"arm":"A"},{"bp":130,"arm":"A"},{"bp":122,"arm":"A"},{"bp":135,"arm":"B"},{"bp":140,"arm":"B"},{"bp":138,"arm":"B"},{"bp":132,"arm":"B"},{"bp":145,"arm":"B"}]'
RUN="{\"test\":\"independent_t_test\",\"variables\":{\"outcome\":\"bp\",\"group\":\"arm\"},\"data\":$ROWS}"

check "Maths request runs in a container" bash -c "grep -q 'cos(x)' <<<\"\$(curl -fsS -X POST '$BASE/api/math/run' -H 'X-API-Key: $KEY' -H 'Content-Type: application/json' -d '$MATH')\""
check "R t-test runs in a container"      bash -c "grep -q 'p_value' <<<\"\$(curl -fsS -X POST '$BASE/api/r/run' -H 'X-API-Key: $KEY' -H 'Content-Type: application/json' -d '$RUN')\""

echo
echo "Timing (one container per job; shows whether a warm pool is needed):"
for _ in 1 2 3; do timed "math job" post /api/math/run "$MATH"; done
for _ in 1 2 3; do timed "R t-test" post /api/r/run "$RUN"; done

echo
if [[ $FAIL -eq 0 ]]; then echo "All checks passed."; else echo "Some checks failed: see journalctl -u omnistat-api -n 100"; fi
exit $FAIL
