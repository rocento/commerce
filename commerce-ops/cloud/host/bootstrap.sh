# Shared protected configuration reader for deployment and explicit demo seeding.
load_bootstrap() {
  [[ -f $BOOTSTRAP ]] || fail "Missing $BOOTSTRAP. Copy commerce-ops/deploy/ec2/bootstrap.env.example to deploy/ec2/bootstrap.env, fill it once, then chmod 600 $BOOTSTRAP."
  local mode key value
  mode=$(stat -c '%a' "$BOOTSTRAP")
  (( (8#$mode & 8#077) == 0 )) || fail "$BOOTSTRAP has mode $mode. Run: chmod 600 $BOOTSTRAP"
  while IFS= read -r value || [[ -n $value ]]; do
    [[ -z $value || ${value:0:1} == '#' ]] && continue
    [[ $value == *=* ]] || fail 'Invalid bootstrap configuration line. Use KEY=value without quotes.'
    key=${value%%=*}; value=${value#*=}
    case "$key" in
      DEMO_ADMIN_ENFORCE)
        [[ $value == 0 || $value == 1 ]] || fail "DEMO_ADMIN_ENFORCE must be 0 or 1."
        export "$key=$value" ;;
      DOMAIN|ORIGIN_CERT|ORIGIN_KEY)
        [[ -n $value ]] || fail "Bootstrap variable $key is empty."
        export "$key=$value" ;;
      GROCERY_ADMIN_EMAIL|GROCERY_ADMIN_PASSWORD|JEWELRY_ADMIN_EMAIL|JEWELRY_ADMIN_PASSWORD|ELECTRONICS_ADMIN_EMAIL|ELECTRONICS_ADMIN_PASSWORD|PHARMACY_ADMIN_EMAIL|PHARMACY_ADMIN_PASSWORD)
        export "$key=$value" ;;
      *) fail "Unsupported bootstrap variable: $key" ;;
    esac
  done < "$BOOTSTRAP"
  for key in DOMAIN ORIGIN_CERT ORIGIN_KEY; do
    [[ -n ${!key:-} ]] || fail "Missing $key in $BOOTSTRAP."
  done
  if [[ $MODE == seed ]]; then
    local stores=(grocery jewelry electronics pharmacy) store email_key password_key
    [[ $SEED_TARGET == all ]] || stores=("$SEED_TARGET")
    for store in "${stores[@]}"; do
      email_key=${store^^}_ADMIN_EMAIL
      password_key=${store^^}_ADMIN_PASSWORD
      [[ ${!email_key:-} == *@*.* ]] || fail "Set $email_key to a valid email in $BOOTSTRAP."
      value=${!password_key:-}
      (( ${#value} >= 12 )) || fail "Set $password_key to at least 12 characters in $BOOTSTRAP."
    done
  fi
}
