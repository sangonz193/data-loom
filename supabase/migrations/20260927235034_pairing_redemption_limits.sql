set
  local check_function_bodies = off;

create extension "pg_cron";

comment on EXTENSION "pg_cron" is 'Job scheduler for PostgreSQL';
