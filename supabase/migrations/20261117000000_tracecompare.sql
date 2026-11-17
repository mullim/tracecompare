begin;

create schema if not exists tracecompare;
revoke all on schema tracecompare from public, anon, authenticated;

create table tracecompare.sets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  payload bytea not null check (octet_length(payload) between 1 and 5242880),
  updated_at timestamptz not null default now()
);
create index sets_owner_updated on tracecompare.sets(owner_id, updated_at desc);

create table tracecompare.shares (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null unique references tracecompare.sets(id) on delete cascade,
  payload bytea not null check (octet_length(payload) between 1 and 1048576)
);
alter table tracecompare.sets enable row level security;
alter table tracecompare.shares enable row level security;
revoke all on all tables in schema tracecompare from public, anon, authenticated;

-- Serialize quota checks with writes so concurrent uploads cannot exceed a cap.
-- Bytes are compressed archives. Leave room for indexes, metadata and updates.
create function tracecompare.check_capacity(account uuid, additional integer)
returns void language plpgsql set search_path = ''
as $$
declare private_bytes bigint; shared_bytes bigint; global_bytes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(927430118);
  if additional <= 0 then return; end if;
  select coalesce(sum(greatest(octet_length(s.payload), 16384)), 0) into private_bytes
    from tracecompare.sets s where s.owner_id = account;
  select coalesce(sum(greatest(octet_length(p.payload), 16384)), 0) into shared_bytes
    from tracecompare.shares p join tracecompare.sets s on p.set_id = s.id where s.owner_id = account;
  if private_bytes + shared_bytes + additional > 20971520 then
    raise exception 'Your 20 MB cloud storage limit is full. Export or delete a saved set to free up space.';
  end if;
  select (select coalesce(sum(greatest(octet_length(payload), 16384)), 0) from tracecompare.sets)
       + (select coalesce(sum(greatest(octet_length(payload), 16384)), 0) from tracecompare.shares)
    into global_bytes;
  if global_bytes + additional > 314572800 then
    raise exception 'The cloud storage limit is full. You can still export this set locally.';
  end if;
end;
$$;

create function public.tc_list_sets()
returns table(id uuid, title text, bytes int, updated_at timestamptz, share_id uuid)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.title, octet_length(s.payload), s.updated_at, p.id
  from tracecompare.sets s left join tracecompare.shares p on p.set_id = s.id
  where s.owner_id = (select auth.uid())
  order by s.updated_at desc
$$;

create function public.tc_save_set(p_id uuid, p_title text, p_data text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare account uuid := auth.uid(); body bytea; existing_bytes integer := 0; saved uuid;
begin
  if account is null then raise exception 'Sign in to save a comparison.'; end if;
  if p_data is null or char_length(p_data) > 6990508 then raise exception 'This set exceeds 5 MB.'; end if;
  body := decode(p_data, 'base64');
  if octet_length(body) not between 1 and 5242880 then raise exception 'This set exceeds 5 MB or is empty.'; end if;
  p_title := left(btrim(coalesce(p_title, '')), 120);
  if p_title = '' then p_title := 'Untitled comparison'; end if;
  perform pg_catalog.pg_advisory_xact_lock(927430118);
  if p_id is not null then
    select greatest(octet_length(s.payload), 16384) into existing_bytes from tracecompare.sets s
      where s.id = p_id and s.owner_id = account for update;
    if not found then raise exception 'Saved set not found.'; end if;
  elsif (select count(*) from tracecompare.sets s where s.owner_id = account) >= 40 then
    raise exception 'You can save up to 40 comparisons.';
  end if;
  perform tracecompare.check_capacity(account, greatest(octet_length(body), 16384) - existing_bytes);
  if p_id is null then
    insert into tracecompare.sets(owner_id, title, payload) values(account, p_title, body) returning id into saved;
  else
    update tracecompare.sets s set title = p_title, payload = body, updated_at = now() where s.id = p_id returning id into saved;
  end if;
  return saved;
end;
$$;

create function public.tc_get_set(p_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select encode(s.payload, 'base64') from tracecompare.sets s where s.id = p_id and s.owner_id = (select auth.uid())
$$;

create function public.tc_publish_set(p_id uuid, p_data text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare account uuid := auth.uid(); body bytea; existing_bytes integer; shared uuid;
begin
  if account is null then raise exception 'Sign in to publish a comparison.'; end if;
  if p_data is null or char_length(p_data) > 1398104 then raise exception 'This share exceeds 1 MB.'; end if;
  body := decode(p_data, 'base64');
  if octet_length(body) not between 1 and 1048576 then raise exception 'This share exceeds 1 MB or is empty.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(927430118);
  perform 1 from tracecompare.sets s where s.id = p_id and s.owner_id = account for update;
  if not found then raise exception 'Saved set not found.'; end if;
  select coalesce((select greatest(octet_length(p.payload), 16384) from tracecompare.shares p where p.set_id = p_id), 0) into existing_bytes;
  perform tracecompare.check_capacity(account, greatest(octet_length(body), 16384) - existing_bytes);
  insert into tracecompare.shares(set_id, payload) values(p_id, body)
  on conflict (set_id) do update set payload = excluded.payload returning id into shared;
  return shared;
end;
$$;

create function public.tc_get_share(p_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select encode(p.payload, 'base64') from tracecompare.shares p where p.id = p_id
$$;

create function public.tc_revoke_share(p_id uuid)
returns void language sql security definer set search_path = ''
as $$
  delete from tracecompare.shares p using tracecompare.sets s
    where p.set_id = s.id and s.id = p_id and s.owner_id = (select auth.uid())
$$;

create function public.tc_delete_set(p_id uuid)
returns void language sql security definer set search_path = ''
as $$
  delete from tracecompare.sets s where s.id = p_id and s.owner_id = (select auth.uid())
$$;

revoke execute on function tracecompare.check_capacity(uuid, integer) from public, anon, authenticated;
revoke execute on function public.tc_list_sets(), public.tc_save_set(uuid, text, text),
  public.tc_get_set(uuid), public.tc_publish_set(uuid, text), public.tc_get_share(uuid),
  public.tc_revoke_share(uuid), public.tc_delete_set(uuid) from public, anon, authenticated;
grant execute on function public.tc_list_sets(), public.tc_save_set(uuid, text, text),
  public.tc_get_set(uuid), public.tc_publish_set(uuid, text), public.tc_revoke_share(uuid),
  public.tc_delete_set(uuid) to authenticated;
grant execute on function public.tc_get_share(uuid) to anon, authenticated;

commit;
