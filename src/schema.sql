-- Run this in your Supabase SQL editor to set up the schema

create table projects (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  ado_org              text,
  ado_project          text,
  period_label         text not null default 'Sprint',
  category_allocations jsonb not null default '[{"name":"Feature Work","pct":100,"color":"#6366F1"}]',
  created_at           timestamptz not null default now()
);

create table forecasts (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  run_date        timestamptz not null default now(),
  backlog_size    integer,
  period_label    text not null default 'Sprint',
  sim_count       integer not null default 10000,
  throughput_data jsonb not null default '[]',
  results         jsonb not null,
  is_baseline     boolean not null default false,
  notes           text
);

create index forecasts_project_id_idx on forecasts(project_id);
create index forecasts_baseline_idx   on forecasts(project_id, is_baseline);
