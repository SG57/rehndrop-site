// Reels as stories: portrait, full screen, progress bars, tap right for the next one, left
// for the last. The videos are self-hosted web cuts (scripts/export_reels.py); the Instagram
// button opens the real post, so likes and comments still land there.
export interface StoryReel {
  id: string;
  track: string;
  title: string;
  date: string;
  url: string;
  video: string | null;
  poster: string | null;
  href: string;
}

export function startStories(reels: StoryReel[], base: string) {
  const dialog = document.querySelector<HTMLDialogElement>('[data-story]');
  if (!dialog || !reels.length) return;
  const video = dialog.querySelector<HTMLVideoElement>('[data-story-video]')!;
  const bars = dialog.querySelector<HTMLElement>('[data-story-bars]')!;
  const title = dialog.querySelector<HTMLAnchorElement>('[data-story-title]')!;
  const date = dialog.querySelector<HTMLElement>('[data-story-date]')!;
  const ig = dialog.querySelector<HTMLAnchorElement>('[data-story-ig]')!;
  const muteBtn = dialog.querySelector<HTMLButtonElement>('[data-story-mute]')!;

  let list: StoryReel[] = [];
  let index = 0;
  let raf = 0;
  const abs = (p: string) => (p.startsWith('http') ? p : base + p);

  const paintBars = () => {
    bars.replaceChildren(
      ...list.map((_, i) => {
        const b = document.createElement('span');
        b.className = 'story-bar';
        b.style.setProperty('--p', i < index ? '1' : '0');
        return b;
      }),
    );
  };
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const bar = bars.children[index] as HTMLElement | undefined;
    if (bar && video.duration) bar.style.setProperty('--p', String(Math.min(1, video.currentTime / video.duration)));
  };

  const show = (i: number) => {
    index = i;
    const r = list[i];
    title.textContent = r.title;
    title.href = r.href;
    date.textContent = r.date;
    ig.href = r.url;
    video.poster = r.poster ? abs(r.poster) : '';
    video.src = abs(r.video!);
    paintBars();
    // play() straight from the tap that opened us; if sound is refused, play muted
    const p = video.play();
    if (p) p.catch(() => {
      video.muted = true;
      dialog.classList.add('is-muted');
      void video.play().catch(() => {});
    });
  };

  const close = () => {
    cancelAnimationFrame(raf);
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (dialog.open) dialog.close();
  };

  const open = (items: StoryReel[], start: number) => {
    const playable = items.filter((r) => r.video);
    const first = items[start];
    if (!first) return;
    if (!first.video) {
      window.open(first.url, '_blank', 'noopener');
      return;
    }
    list = playable;
    document.dispatchEvent(new CustomEvent('rehndrop:pause'));
    dialog.showModal();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    show(Math.max(0, list.indexOf(first)));
  };

  const next = () => (index < list.length - 1 ? show(index + 1) : close());
  const prev = () => (index > 0 ? show(index - 1) : (video.currentTime = 0));

  video.addEventListener('ended', next);
  dialog.querySelector('[data-story-next]')!.addEventListener('click', next);
  dialog.querySelector('[data-story-prev]')!.addEventListener('click', prev);
  dialog.querySelector('[data-story-close]')!.addEventListener('click', close);
  dialog.addEventListener('close', close);
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    dialog.classList.toggle('is-muted', video.muted);
    muteBtn.setAttribute('aria-label', video.muted ? 'unmute' : 'mute');
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
  });
  // swipe down to dismiss, like stories
  let y0 = 0;
  let x0 = 0;
  dialog.addEventListener('pointerdown', (e) => {
    y0 = e.clientY;
    x0 = e.clientX;
  });
  dialog.addEventListener('pointerup', (e) => {
    if (e.clientY - y0 > 90 && Math.abs(e.clientX - x0) < 60) close();
  });

  const byTrack = (slug: string) => reels.filter((r) => r.track === slug);
  document.addEventListener('click', (e) => {
    const t = e.target as Element;
    const one = t.closest<HTMLElement>('[data-story-reel]');
    const track = t.closest<HTMLElement>('[data-story-track]');
    if (!one && !track) return;
    e.preventDefault();
    e.stopPropagation();
    if (one) {
      const scope = one.dataset.storyList?.startsWith('track:') ? byTrack(one.dataset.storyList.slice(6)) : reels;
      open(scope, scope.findIndex((r) => r.id === one.dataset.storyReel));
    } else {
      open(byTrack(track!.dataset.storyTrack!), 0);
    }
  });
}
