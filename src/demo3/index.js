import { MP4Demux, Events } from 'demuxer';

var demuxer = new MP4Demux({ debug: true });

var xhr = new XMLHttpRequest();
xhr.open(
  'GET',
  'https://ks3-cn-beijing.ksyun.com/ksplayer/h265/mp4_resource/57s.mp4',
  true,
);
xhr.responseType = 'arraybuffer';
const startIdx = 16;
const chunkSize = 384 * 1024;
// xhr.setRequestHeader('Range', `bytes=${chunkSize * startIdx}-${chunkSize * (startIdx + 1) - 1}`);

xhr.send();
xhr.onreadystatechange = function () {
  if (xhr.readyState === 4) {
    console.log(new Int8Array(xhr.response));
    demuxer.push(xhr.response);
  }
};


demuxer.on(Events.DEMUX_DATA, e => {
  console.log(e);
})
