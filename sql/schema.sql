-- =====================================================================
-- Client Reporting Follow-up Board — schema
-- Single-admin app (owner_id kept for a future multi-user cut per PRD C5)
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists report_followups (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  owner_id          uuid not null default '00000000-0000-0000-0000-000000000001',
  client_name       text not null,
  report_month      text not null,
  fee_minor         integer not null,
  currency          text not null default 'USD',
  stage             text not null default 'Due',
  report_due_date   date not null,
  payment_due_date  date
);

-- ---------- required fields, formats, allowed values ----------
alter table report_followups drop constraint if exists report_followups_client_name_check;
alter table report_followups add constraint report_followups_client_name_check
  check (length(btrim(client_name)) between 1 and 120);

alter table report_followups drop constraint if exists report_followups_report_month_check;
alter table report_followups add constraint report_followups_report_month_check
  check (report_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

alter table report_followups drop constraint if exists report_followups_fee_minor_check;
alter table report_followups add constraint report_followups_fee_minor_check
  check (fee_minor > 0);

alter table report_followups drop constraint if exists report_followups_currency_check;
alter table report_followups add constraint report_followups_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table report_followups drop constraint if exists report_followups_stage_check;
alter table report_followups add constraint report_followups_stage_check
  check (stage in ('Due','Sent','Invoiced','Paid'));

-- one row per owner, client and month (C1)
create unique index if not exists report_followups_one_per_month
  on report_followups (owner_id, lower(btrim(client_name)), report_month);

-- ---------- the stage state machine (C6): one step at a time ----------
create or replace function report_followups_guard_stage()
returns trigger
language plpgsql
as $$
declare
  stages text[] := array['Due','Sent','Invoiced','Paid'];
  step   integer;
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed on an existing row';
  end if;
  if new.stage is not distinct from old.stage then
    new.updated_at := now();
    return new;
  end if;
  step := array_position(stages, new.stage) - array_position(stages, old.stage);
  if step not in (-1, 1) then
    raise exception 'Stage cannot move from % to % in one step', old.stage, new.stage;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists report_followups_guard_stage on report_followups;
create trigger report_followups_guard_stage
  before update on report_followups
  for each row execute function report_followups_guard_stage();

-- ---------- the overdue rule, in exactly one place (C4) ----------
create or replace function report_followups_is_overdue(
  p_stage        text,
  p_report_due   date,
  p_payment_due  date,
  p_today        date default current_date
)
returns boolean
language sql
immutable
as $$
  select case
    when p_stage = 'Due'      then p_report_due < p_today
    when p_stage = 'Invoiced' then p_payment_due is not null
                                    and p_payment_due < p_today
    else false
  end;
$$;

-- ---------- derived reads: never store a total ----------
create or replace view report_followups_board as
select
  r.id,
  r.created_at,
  r.updated_at,
  r.owner_id,
  r.client_name,
  r.report_month,
  r.fee_minor,
  r.currency,
  r.stage,
  r.report_due_date,
  r.payment_due_date,
  report_followups_is_overdue(r.stage, r.report_due_date, r.payment_due_date) as is_overdue,
  case
    when r.stage = 'Invoiced' then r.payment_due_date
    else r.report_due_date
  end as chase_date
from report_followups r;

create or replace view report_followups_money as
select
  r.owner_id,
  coalesce(sum(r.fee_minor) filter (where r.stage = 'Due'), 0)                as not_sent_minor,
  coalesce(sum(r.fee_minor) filter (where r.stage in ('Sent','Invoiced')), 0) as sent_unpaid_minor,
  count(*) filter (where r.stage = 'Due')                                     as not_sent_rows,
  count(*) filter (where r.stage in ('Sent','Invoiced'))                      as sent_unpaid_rows,
  count(*) filter (where report_followups_is_overdue(
      r.stage, r.report_due_date, r.payment_due_date))                       as overdue_rows
from report_followups r
group by r.owner_id;
