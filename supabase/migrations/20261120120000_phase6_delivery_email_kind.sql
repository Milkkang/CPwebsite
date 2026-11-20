-- Keep the enum change separate so PostgreSQL can commit it before the value is used.
alter type public.email_job_kind add value if not exists 'delivery';
