import { siApplemusic, siFacebook, siInstagram, siSoundcloud, siSpotify, siYoutube, siYoutubemusic } from 'simple-icons';

export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');
export const u = (path = '') => BASE + path.replace(/^\//, '');

export const icons = {
  spotify: siSpotify.path,
  apple: siApplemusic.path,
  soundcloud: siSoundcloud.path,
  youtube: siYoutube.path,
  ytmusic: siYoutubemusic.path,
  instagram: siInstagram.path,
  facebook: siFacebook.path,
} as const;

export type IconName = keyof typeof icons;

export const BIO = 'dubstep, riddim, glitch hop, future bass. the heavy stuff and the pretty stuff. san diego.';
