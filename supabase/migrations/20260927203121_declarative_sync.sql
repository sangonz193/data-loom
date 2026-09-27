set
  local check_function_bodies = off;

revoke all on FUNCTION "public"."complete_device_link" (uuid, text, uuid, timestamp WITH time zone)
from
  "anon";

revoke all on FUNCTION "public"."complete_device_link" (uuid, text, uuid, timestamp WITH time zone)
from
  "authenticated";
