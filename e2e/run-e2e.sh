#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
E2E_DIR="${ROOT}/e2e"
CATALOG_SCRIPT="${E2E_DIR}/lib/test-catalog.mjs"

TMP_DIR=""
cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf -- "${TMP_DIR}"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: ./e2e/run-e2e.sh [options]

Unified opaque-box E2E test runner for Native iOS Transaction Container (@internal/kiosk-host).

Options:
  --tier <1|2|3|4|all>              Select E2E tier(s) to list or execute (default: all)
  --suite <swift|js|structural|all> Select suite(s) to list or execute (default: all)
  --list                            List discovered E2E tests and per-tier/per-feature counts
  --check-coverage                  Enforce all global E2E coverage & integrity thresholds
  -h, --help                        Show this usage message and exit

Examples:
  ./e2e/run-e2e.sh --list
  ./e2e/run-e2e.sh --list --tier 1 --suite swift
  ./e2e/run-e2e.sh --check-coverage
  ./e2e/run-e2e.sh --tier 1
  ./e2e/run-e2e.sh --tier 1 --suite js
  ./e2e/run-e2e.sh --tier all

Exit Codes:
  0   All selected tests executed non-vacuously and passed (or catalog/help succeeded)
  1   Test failure, missing toolchain/files, 0 discovered tests, skipped/todo tests,
      catalog integrity violation, or unmet coverage threshold
  2   Invalid CLI arguments
EOF
}

die_usage() {
  local msg="$1"
  printf 'Error: %s\n\n' "$msg" >&2
  usage >&2
  exit 2
}

validate_tier() {
  case "$1" in
    1|2|3|4|all) return 0 ;;
    *) return 1 ;;
  esac
}

validate_suite() {
  case "$1" in
    swift|js|structural|all) return 0 ;;
    *) return 1 ;;
  esac
}

TIER="all"
SUITE="all"
MODE_LIST=0
MODE_CHECK_COVERAGE=0
SHOW_HELP=0

# Parse ENTIRE argv before honoring --help so invalid combinations like `--help --bogus` exit 2.
while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    --tier)
      if [[ $# -lt 2 ]]; then
        die_usage "Option --tier requires a value (1|2|3|4|all)"
      fi
      val="$2"
      if [[ -z "$val" ]] || ! validate_tier "$val"; then
        die_usage "Invalid --tier value '${val}' (expected 1|2|3|4|all)"
      fi
      TIER="$val"
      shift 2
      ;;
    --tier=*)
      val="${arg#--tier=}"
      if [[ -z "$val" ]] || ! validate_tier "$val"; then
        die_usage "Invalid --tier value '${val}' (expected 1|2|3|4|all)"
      fi
      TIER="$val"
      shift
      ;;
    --suite)
      if [[ $# -lt 2 ]]; then
        die_usage "Option --suite requires a value (swift|js|structural|all)"
      fi
      val="$2"
      if [[ -z "$val" ]] || ! validate_suite "$val"; then
        die_usage "Invalid --suite value '${val}' (expected swift|js|structural|all)"
      fi
      SUITE="$val"
      shift 2
      ;;
    --suite=*)
      val="${arg#--suite=}"
      if [[ -z "$val" ]] || ! validate_suite "$val"; then
        die_usage "Invalid --suite value '${val}' (expected swift|js|structural|all)"
      fi
      SUITE="$val"
      shift
      ;;
    --list)
      MODE_LIST=1
      shift
      ;;
    --list=*)
      die_usage "Flag --list does not accept a value"
      ;;
    --check-coverage)
      MODE_CHECK_COVERAGE=1
      shift
      ;;
    --check-coverage=*)
      die_usage "Flag --check-coverage does not accept a value"
      ;;
    -h|--help)
      SHOW_HELP=1
      shift
      ;;
    --help=*|-h=*)
      die_usage "Flag --help does not accept a value"
      ;;
    *)
      die_usage "Unknown or unexpected argument: '${arg}'"
      ;;
  esac
done

if [[ "${SHOW_HELP}" -eq 1 ]]; then
  usage
  exit 0
fi

# Verify Node.js & catalog script before catalog or execution modes
if ! command -v node >/dev/null 2>&1; then
  printf 'Error: Required runtime "node" not found in PATH\n' >&2
  exit 1
fi
if [[ ! -f "${CATALOG_SCRIPT}" ]]; then
  printf 'Error: Required catalog script not found at %s\n' "${CATALOG_SCRIPT}" >&2
  exit 1
fi

# Catalog / Coverage modes
if [[ "${MODE_LIST}" -eq 1 && "${MODE_CHECK_COVERAGE}" -eq 0 ]]; then
  exec node "${CATALOG_SCRIPT}" --list --tier "${TIER}" --suite "${SUITE}"
elif [[ "${MODE_LIST}" -eq 0 && "${MODE_CHECK_COVERAGE}" -eq 1 ]]; then
  exec node "${CATALOG_SCRIPT}" --check-coverage
elif [[ "${MODE_LIST}" -eq 1 && "${MODE_CHECK_COVERAGE}" -eq 1 ]]; then
  exec node "${CATALOG_SCRIPT}" --list --check-coverage --tier "${TIER}" --suite "${SUITE}"
fi

# Execution mode
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rntxn-e2e.XXXXXX")"

if [[ "${TIER}" == "all" ]]; then
  TIERS=(1 2 3 4)
else
  TIERS=("${TIER}")
fi

if [[ "${SUITE}" == "all" ]]; then
  SUITES=(swift js structural)
else
  SUITES=("${SUITE}")
fi

CELL_TIERS=()
CELL_SUITES=()
CELL_STATUS=()
CELL_EXECUTED=()
CELL_SKIPPED=()
CELL_DETAILS=()

record_cell() {
  CELL_TIERS+=("$1")
  CELL_SUITES+=("$2")
  CELL_STATUS+=("$3")
  CELL_EXECUTED+=("$4")
  CELL_SKIPPED+=("$5")
  CELL_DETAILS+=("$6")
}

# Queries catalog pre-flight metadata for a (tier, suite) cell.
# Populates global PREFLIGHT_COUNT, PREFLIGHT_SCOPE_OK, PREFLIGHT_SUMMARY.
query_cell_preflight() {
  local tier="$1"
  local suite="$2"
  PREFLIGHT_COUNT=0
  PREFLIGHT_SCOPE_OK="false"
  PREFLIGHT_SUMMARY=""

  local meta_json=""
  local meta_rc=0
  meta_json="$(node "${CATALOG_SCRIPT}" --json --tier "${tier}" --suite "${suite}" 2>/dev/null)" || meta_rc=$?

  if [[ -z "${meta_json}" ]]; then
    PREFLIGHT_SUMMARY="catalog query failed (exit ${meta_rc})"
    return 1
  fi

  local parsed_lines=""
  local parse_rc=0
  parsed_lines="$(node --input-type=module -e '
    const fs = await import("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    console.log(String(data.filteredCount ?? 0));
    console.log(data.scopeIntegrityOk === true ? "true" : "false");
    console.log(String(data.scopeViolationSummary ?? "").replace(/[\r\n]+/g, " "));
  ' <<< "${meta_json}" 2>/dev/null)" || parse_rc=$?

  if [[ "${parse_rc}" -ne 0 ]]; then
    PREFLIGHT_SUMMARY="failed to parse catalog pre-flight JSON"
    return 1
  fi

  local line1="" line2="" line3=""
  {
    IFS= read -r line1 || true
    IFS= read -r line2 || true
    IFS= read -r line3 || true
  } <<< "${parsed_lines}"

  PREFLIGHT_COUNT="${line1:-0}"
  PREFLIGHT_SCOPE_OK="${line2:-false}"
  PREFLIGHT_SUMMARY="${line3:-}"
  return 0
}

extract_kv_int() {
  local text="$1"
  local key="$2"
  local fallback="${3:-0}"
  if [[ "$text" =~ ${key}=([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "${fallback}"
  fi
}

run_swift_tier() {
  local tier="$1"
  local suite="swift"
  local pkg_dir="${E2E_DIR}/swift"
  local target_name="E2ETier${tier}Tests"
  local target_dir="${pkg_dir}/Tests/${target_name}"

  printf '\n>>> Running Tier %s [%s] (%s)\n' "${tier}" "${suite}" "${target_name}"

  # Layer 1: Toolchain availability (never skip-as-pass!)
  if ! command -v swift >/dev/null 2>&1; then
    printf 'FAIL: swift toolchain not found in PATH\n' >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "swift toolchain not found in PATH"
    return 1
  fi

  # Layer 2: Manifest & test target directory existence
  if [[ ! -f "${pkg_dir}/Package.swift" ]]; then
    local msg="Missing SwiftPM manifest: e2e/swift/Package.swift"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi
  if [[ ! -d "${target_dir}" ]]; then
    local msg="Missing Swift test directory: e2e/swift/Tests/${target_name}"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi

  # Layer 3: Catalog non-vacuous pre-flight
  local pf_rc=0
  query_cell_preflight "${tier}" "${suite}" || pf_rc=$?
  if [[ "${pf_rc}" -ne 0 ]]; then
    printf 'FAIL: %s\n' "${PREFLIGHT_SUMMARY}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${PREFLIGHT_SUMMARY}"
    return 1
  fi
  if [[ "${PREFLIGHT_SCOPE_OK}" != "true" ]]; then
    local msg="Catalog integrity violation in tier ${tier} ${suite}: ${PREFLIGHT_SUMMARY}"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi
  if [[ "${PREFLIGHT_COUNT}" -lt 1 ]]; then
    local msg="0 Swift E2E tests discovered in ${target_name} (non-vacuous guard)"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi

  # Layer 4: Execution + post-flight log verification
  local log_file="${TMP_DIR}/swift-tier${tier}.log"
  local swift_rc=0
  swift test --package-path "${pkg_dir}" --filter "${target_name}" 2>&1 | tee "${log_file}" || swift_rc=$?

  local verify_out=""
  local verify_rc=0
  verify_out="$(node "${CATALOG_SCRIPT}" --verify-swift-log "${log_file}" --min-tests "${PREFLIGHT_COUNT}" 2>&1)" || verify_rc=$?

  local executed skipped
  executed="$(extract_kv_int "${verify_out}" "executed" "0")"
  skipped="$(extract_kv_int "${verify_out}" "skipped" "0")"

  if [[ "${swift_rc}" -ne 0 ]]; then
    local detail="swift test exited ${swift_rc} (${verify_out})"
    printf 'FAIL: %s\n' "${detail}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "${executed}" "${skipped}" "${detail}"
    return 1
  fi
  if [[ "${verify_rc}" -ne 0 ]]; then
    local detail="Swift post-flight guard failed: ${verify_out}"
    printf 'FAIL: %s\n' "${detail}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "${executed}" "${skipped}" "${detail}"
    return 1
  fi

  record_cell "${tier}" "${suite}" "PASS" "${executed}" "${skipped}" "All ${executed} Swift test(s) passed"
  return 0
}

run_node_tier() {
  local tier="$1"
  local suite="$2"
  local target_dir="$3"
  local rel_dir="${target_dir#${ROOT}/}"

  printf '\n>>> Running Tier %s [%s] (%s)\n' "${tier}" "${suite}" "${rel_dir}"

  # Layer 1: Directory existence
  if [[ ! -d "${target_dir}" ]]; then
    local msg="Missing test directory: ${rel_dir}"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi

  # Layer 2: Deterministic .test.mjs file discovery
  local -a test_files=()
  local list_file="${TMP_DIR}/${suite}-tier${tier}.files"
  local find_rc=0
  find "${target_dir}" -type f -name '*.test.mjs' | LC_ALL=C sort > "${list_file}" || find_rc=$?
  if [[ "${find_rc}" -ne 0 ]]; then
    local msg="Failed to enumerate test files in ${rel_dir}"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi
  mapfile -t test_files < "${list_file}"
  if [[ "${#test_files[@]}" -eq 0 ]]; then
    local msg="0 .test.mjs files found in ${rel_dir} (non-vacuous guard)"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi

  # Layer 3: Catalog non-vacuous pre-flight
  local pf_rc=0
  query_cell_preflight "${tier}" "${suite}" || pf_rc=$?
  if [[ "${pf_rc}" -ne 0 ]]; then
    printf 'FAIL: %s\n' "${PREFLIGHT_SUMMARY}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${PREFLIGHT_SUMMARY}"
    return 1
  fi
  if [[ "${PREFLIGHT_SCOPE_OK}" != "true" ]]; then
    local msg="Catalog integrity violation in tier ${tier} ${suite}: ${PREFLIGHT_SUMMARY}"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi
  if [[ "${PREFLIGHT_COUNT}" -lt 1 ]]; then
    local msg="0 cataloged E2E tests found in ${rel_dir} (non-vacuous guard)"
    printf 'FAIL: %s\n' "${msg}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "0" "0" "${msg}"
    return 1
  fi

  # Layer 4: Dual-reporter Node execution + TAP post-flight verification
  local tap_file="${TMP_DIR}/${suite}-tier${tier}.tap"
  local node_rc=0
  node --test \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=tap --test-reporter-destination="${tap_file}" \
    "${test_files[@]}" || node_rc=$?

  local verify_out=""
  local verify_rc=0
  verify_out="$(node "${CATALOG_SCRIPT}" --verify-tap "${tap_file}" --min-tests "${PREFLIGHT_COUNT}" 2>&1)" || verify_rc=$?

  local executed skipped
  executed="$(extract_kv_int "${verify_out}" "executed" "0")"
  skipped="$(extract_kv_int "${verify_out}" "skipped" "0")"

  if [[ "${node_rc}" -ne 0 ]]; then
    local detail="node --test exited ${node_rc} (${verify_out})"
    printf 'FAIL: %s\n' "${detail}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "${executed}" "${skipped}" "${detail}"
    return 1
  fi
  if [[ "${verify_rc}" -ne 0 ]]; then
    local detail="TAP post-flight guard failed: ${verify_out}"
    printf 'FAIL: %s\n' "${detail}" >&2
    record_cell "${tier}" "${suite}" "FAIL" "${executed}" "${skipped}" "${detail}"
    return 1
  fi

  record_cell "${tier}" "${suite}" "PASS" "${executed}" "${skipped}" "All ${executed} ${suite} test(s) passed"
  return 0
}

total_cells=0
passed_cells=0
failed_cells=0

for tier in "${TIERS[@]}"; do
  for suite in "${SUITES[@]}"; do
    total_cells=$((total_cells + 1))
    cell_rc=0
    case "${suite}" in
      swift)
        run_swift_tier "${tier}" || cell_rc=$?
        ;;
      js)
        run_node_tier "${tier}" "js" "${E2E_DIR}/js/tier${tier}" || cell_rc=$?
        ;;
      structural)
        run_node_tier "${tier}" "structural" "${E2E_DIR}/ios-structural/tier${tier}" || cell_rc=$?
        ;;
    esac
    if [[ "${cell_rc}" -eq 0 ]]; then
      passed_cells=$((passed_cells + 1))
    else
      failed_cells=$((failed_cells + 1))
    fi
  done
done

printf '\n====================================================================================\n'
printf 'E2E Execution Summary\n'
printf '====================================================================================\n'
printf '%-8s %-12s %-8s %-10s %-9s %s\n' "Tier" "Suite" "Status" "Executed" "Skipped" "Details"
printf '%s\n' '------------------------------------------------------------------------------------'
for idx in "${!CELL_TIERS[@]}"; do
  printf 'Tier %-3s %-12s %-8s %-10s %-9s %s\n' \
    "${CELL_TIERS[$idx]}" \
    "${CELL_SUITES[$idx]}" \
    "${CELL_STATUS[$idx]}" \
    "${CELL_EXECUTED[$idx]}" \
    "${CELL_SKIPPED[$idx]}" \
    "${CELL_DETAILS[$idx]}"
done
printf '%s\n' '------------------------------------------------------------------------------------'

if [[ "${total_cells}" -gt 0 && "${failed_cells}" -eq 0 ]]; then
  printf 'Result: PASS (%d/%d passed, 0 failed)\n' "${passed_cells}" "${total_cells}"
  printf '====================================================================================\n'
  exit 0
else
  printf 'Result: FAIL (%d/%d passed, %d failed)\n' "${passed_cells}" "${total_cells}" "${failed_cells}"
  printf '====================================================================================\n'
  exit 1
fi
