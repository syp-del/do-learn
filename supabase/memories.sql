-- 여행·그림일기 사진용 비공개 저장소 (2026-09-25 적용한 것과 같다. 여러 번 실행해도 된다)
-- 폴더 이름 = x-family-id 헤더의 SHA-256. 가족 ID 자체는 사진 주소에 드러나지 않는다.
-- 사진은 하루짜리 서명 주소(signed URL)로만 보인다. 공개 주소는 열리지 않는다.
-- current_family_id() 는 원래 있던 함수(요청 헤더의 x-family-id → uuid)다.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memories', 'memories', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.current_family_hash()
returns text
language sql
stable
set search_path = ''
as $$
  select encode(extensions.digest(public.current_family_id()::text, 'sha256'), 'hex')
$$;

-- 앱이 저장소가 있는지 물어볼 때 쓴다. 저장소와 함께 만들기 때문에, 함수가 있으면 저장소도 있다.
create or replace function public.memories_ready()
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$ select true $$;
grant execute on function public.memories_ready() to anon, authenticated;

drop policy if exists memories_read_own on storage.objects;
drop policy if exists memories_write_own on storage.objects;
drop policy if exists memories_delete_own on storage.objects;
create policy memories_read_own on storage.objects for select to anon, authenticated
  using (bucket_id = 'memories' and (storage.foldername(name))[1] = (select public.current_family_hash()));
create policy memories_write_own on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'memories' and (storage.foldername(name))[1] = (select public.current_family_hash()));
create policy memories_delete_own on storage.objects for delete to anon, authenticated
  using (bucket_id = 'memories' and (storage.foldername(name))[1] = (select public.current_family_hash()));
