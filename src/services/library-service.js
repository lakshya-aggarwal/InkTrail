export function createLibraryService(repositories, sourceImportService) {
  function withReadingProgress(novel) {
    return {
      ...novel,
      readingProgress: repositories.progress.getReadingProgress(novel.id)
    };
  }

  return {
    createNovel(input) {
      return repositories.novels.createNovel(input);
    },

    listNovels() {
      return repositories.novels.listNovels().map(withReadingProgress);
    },

    getNovel(novelId) {
      return withReadingProgress(repositories.novels.getNovel(novelId));
    },

    recordChapter(novelId, input) {
      return repositories.chapters.recordChapter({ ...input, novelId });
    },

    getReaderChapter(novelId, chapterNumber) {
      return repositories.chapters.getReaderChapter(novelId, Number(chapterNumber));
    },

    setReadingProgress(novelId, input) {
      return repositories.progress.setReadingProgress({ ...input, novelId });
    },

    async importSourceChapter(novelId, input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return sourceImportService.importChapter(input);
      }
      const { created, ...sourceChapter } = await sourceImportService.importChapter({ ...input, novelId });
      return { created, sourceChapter };
    }
  };
}
