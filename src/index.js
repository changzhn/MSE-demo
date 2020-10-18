var video = document.querySelector('video');
var totalBytes = 0;
var baseBytes = 1000 * 1000 - 1;
var queue = [];
var sourceBuffer = null;

var assetURL = 'frag_bunny.mp4';

// Need to be specific for Blink regarding codecs
// ./mp4info frag_bunny.mp4 | grep Codec
var mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

if ('MediaSource' in window && MediaSource.isTypeSupported(mimeCodec)) {
  var mediaSource = new MediaSource();
  //console.log(mediaSource.readyState); // closed
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener('sourceopen', sourceOpen);
} else {
  console.error('Unsupported MIME type or codec: ', mimeCodec);
}

async function sourceOpen (_) {
  //console.log(this.readyState); // open
  var mediaSource = this;
  if (!sourceBuffer) {
    sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
  }
  // console.log('mode: %s', sourceBuffer.mode);

  sourceBuffer.addEventListener('error', function(e) {
    console.trace(e)
  })

  sourceBuffer.addEventListener('updateend', function (_) {
    if (!sourceBuffer.updating && mediaSource.readyState === 'open' && !queue.length) {
      mediaSource.endOfStream();
    }
    console.log(mediaSource.sourceBuffers);
    if (queue.length) {
      console.log('updateend: 从queue取出一个buf');
      sourceBuffer.appendBuffer(queue.shift());
    }
    video.play();
  });

  fetchAB();
};


function fetchAB (start = 0) {
  var rangePrefix = 'bytes=';
  var end = 0;
  if (!totalBytes) {
    // 第一次请求

    end = baseBytes;
  } else {
    if (totalBytes - start < baseBytes) {
      end = totalBytes;
    } else {
      end = start + baseBytes;
    }
  }
  rangePrefix += start;
  rangePrefix += '-';
  rangePrefix += end;

  fetch(assetURL, {
    responseType: 'arraybuffer',
    headers: {
      range: rangePrefix,
    }
  }).then(res => {
    if (!totalBytes) {
      var contentRange = res.headers.get('Content-Range');
      totalBytes = +contentRange.split('/')[1];
    }
    return res.arrayBuffer();
  })
  .then(buf => {
    if (sourceBuffer.updating || queue.length) {
      console.log('is updating, push到队列中');
      queue.push(buf)
    } else {
      console.log('updated, appendBuffer');
      sourceBuffer.appendBuffer(buf)
    }
    if (end + 1 < totalBytes) {
      fetchAB(end + 1);
    } else {
      console.log('fetch end');
    }
  })
};
