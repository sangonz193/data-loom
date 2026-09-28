set
  local check_function_bodies = off;

revoke all on FUNCTION "public"."redeem_pairing_code" (uuid, inet, text, text, integer)
from
  "anon";

revoke all on FUNCTION "public"."redeem_pairing_code" (uuid, inet, text, text, integer)
from
  "authenticated";

revoke all on table "public"."pairing_redemption_failures"
from
  "anon";

revoke all on table "public"."pairing_redemption_failures"
from
  "authenticated";
