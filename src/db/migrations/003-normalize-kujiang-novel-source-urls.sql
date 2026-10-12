update novel_sources
set
  source_url = 'https://www.kujiang.com/book/' || external_novel_id,
  normalized_url = 'https://www.kujiang.com/book/' || external_novel_id
where site = 'kujiang'
  and source_url = normalized_url
  and normalized_url like 'https://www.kujiang.com/book/' || external_novel_id || '/%'
  and exists (
    select 1
    from chapter_sources
    where chapter_sources.novel_source_id = novel_sources.id
      and chapter_sources.normalized_url = novel_sources.normalized_url
  );
