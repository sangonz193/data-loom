set
  local check_function_bodies = off;

revoke all on FUNCTION "public"."cancel_share_request" (uuid, uuid)
from
  "anon";

revoke all on FUNCTION "public"."cancel_share_request" (uuid, uuid)
from
  "authenticated";
