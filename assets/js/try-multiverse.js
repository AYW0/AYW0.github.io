// MultiVerse project page: the steering pipeline from the interactive story, in the page's style.
// Turn the creator's controls on or off and switch listeners; each version can be played.
import { MvPipe } from '/listensback/js/story-viz.js';

const root = document.getElementById('try-mv');
let clip = null;
function play(name) {
  if (clip) { clip.pause(); clip = null; }
  const a = new Audio(`/listensback/audio/multiverse/${name}.mp3`);
  clip = a; a.play().catch(() => {});
}
const pipe = new MvPipe(root, (name) => play(name));
pipe.onChange = () => { if (clip) { clip.pause(); clip = null; } };
