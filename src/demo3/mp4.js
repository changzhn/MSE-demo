import EventEmitter from "events"; //'event-emitter'
import Merge from "deepmerge";
import Parser from "./parse";
// import Buffer from "./fmp4/buffer";
// import FMP4 from "./fmp4/mp4";
import Task from "./media/task";
import util from "./util";
import Errors from "./error";
import TransCoder from "./util/TransCoder";
import Track from "./parse/track";
import {ErrorTypes, ErrorDetails} from '../player/player-errors.js';
import MediaInfo from '../core/media-info.js';
import TransmuxingEvents from '../core/transmuxing-events.js';

class MP4 extends TransCoder {
  /**
   * [constructor 构造函数]
   * @param {String} url                                    [视频地址]
   * @param {Number} [chunk_size=Math.pow(25, 4)]           [请求的数据块大小，对于长视频设置的较大些可以避免二次请求]
   */
  constructor(url, transCtlEvent, chunkSize = Math.pow(25, 4)) {
    super();
    EventEmitter(this);
    this.url = url;
    this.transCtlEvent = transCtlEvent;
    this.CHUNK_SIZE = chunkSize;
    this.init(url);
    this.once("moovReady", function() {
      // try {
        this.moovParse();
      // } catch (error) {
      //   // debugger
      //   let obj = {
      //       type: ErrorTypes.MEDIA_ERROR,
      //       detail: ErrorDetails.MEDIA_METADATAPARSE_ERROR,
      //       info: {code: -1009, msg: 'Metadata parse error'}
      //   };
      //   this.emit("metadataParse_error", obj);
      // }
    }.bind(this));
    this.isMP4 = false;
    this._onTrackMetadata = null;
    this._videoTrack = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    this._audioTrack = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};
    this._onMediaInfo = {};
    this.samples = [];
    this.rangeFrom = 0;
    this.vsIndex = 0;
    this.asIndex = 0;
    this.receivedLength = 0;

    this._mediaInfo = new MediaInfo();

    this.isSeeking = false;  //是否正在seek操作
    this.seekTime = 0;    // seek的真实时间
    this.seekIdr = {
      pts: 0
    };  // 小于等于seekTime最近的idr帧
  }

  bindDataSource(loader) { //将loader和demuxer串联
      this.ioctl = loader;
      return this;
  }

  /**
   * [getData 根据字节区间下载二进制数据]
   * @param  {Number} [start=0]  [起始字节]
   * @param  {Number} [end=start + this.CHUNK_SIZE] [截止字节]
   */
  getData(data) {
    let {start = 0, end = start + this.CHUNK_SIZE, success, error} = data;
    new Task(this.url, [start, end], success, error);
  }

  sortData(a, b) {
    return a.offset - b.offset;
  }

  /**
   * [moovParse 解析视频信息]
   * @return {[type]} [description]
   */
  moovParse() {
    let self = this;
    let moov = this.moovBox;
    let mvhd = util.findBox(moov, "mvhd");
    let traks = util.findBox(moov, "trak");
    let videoTrak, audioTrak;
    let videoCodec, audioCodec, codec;
    let videoTimeScale, audioTimeScale;
    let vps, sps, pps, profile, width, height;
    let channelCount, sampleRate, decoderConfig;
    let fps, refSampleDuration;
    let video_elst, audio_elst;
    let videoTrakId, audioTrakId;
    
    traks.forEach(trak => {
      let hdlr = util.findBox(trak, "hdlr");
      let mdhd = util.findBox(trak, "mdhd");
      if (!hdlr || !mdhd) {
        self.emit(
          "error",
          new Errors("parse", "", {
            line: 72,
            handle: "[MP4] moovParse",
            url: self.url
          })
        );
        return;
      }
      let stsd = util.findBox(trak, "stsd");
      let codecBox = stsd.subBox[0];
      let stsz = util.findBox(trak, "stsz");
      let stts = util.findBox(trak, "stts");
      let tkhd = util.findBox(trak, "tkhd");

      if (hdlr.handleType === "vide") {
        let hvcC = util.findBox(trak, "hvcC");
        video_elst = util.findBox(trak, "elst");
        // console.warn('video elst: ', video_elst.entries);
        this.videoTrakParsed = new Track(trak, mvhd);
        videoTrak = trak;
        videoTimeScale = mdhd.timescale;
        // console.warn('video timescale: ', videoTimeScale);
        codec = codecBox.type;
        if (hvcC) {
          videoCodec =
            `${codecBox.type}.` +
            util
              .toHex(
                hvcC.profile,
                hvcC.profileCompatibility,
                hvcC.configVersion
              )
              .join("");
          vps = hvcC.vps;
          sps = hvcC.sps;
          pps = hvcC.pps;
          profile = hvcC.profile;
        } else {
          videoCodec = `${codecBox.type}`;
        }
        if (tkhd) {
          width = parseInt(tkhd.width);
          height = parseInt(tkhd.height);
          videoTrakId = parseInt(tkhd.trackID);
        }
        fps = Math.round(stsz.count / (mvhd.duration / mvhd.timeScale));

        if (codec === 'hev1' || codec === 'hvc1') {
            /* ----- video sample offset and size  开始 ------- */
            let videoSampleLen = this.videoTrakParsed.getSampleCount();
            this.videoSamples = [];
            for (let i = 0; i < videoSampleLen; i++) {
              let vo = this.videoTrakParsed.sampleToOffset(i);
              let vs = this.videoTrakParsed.sampleToSize(i, 1);
              let pts = this.videoTrakParsed.sampleToPTSTime(i);
              let dts = this.videoTrakParsed.sampleToDTSTime(i);
              this.videoSamples.push({
                type: 'video',
                offset: vo,
                size: vs,
                pts: pts * mvhd.timeScale,
                dts: dts * mvhd.timeScale,
              });
            }
            /* ----- video sample offset and size  结束 ------- */
            // console.log('video sample info:', this.videoSamples);
            // debugger
        }
      }
      if (hdlr.handleType === "soun") {
        if (tkhd) {
          audioTrakId = parseInt(tkhd.trackID);
        }

        audio_elst = util.findBox(trak, "elst");
        audioTrak = trak;
        // console.warn('audio elst: ', audio_elst.entries);
        let esds = util.findBox(trak, "esds");
        let mp4a = util.findBox(trak, "mp4a");
        let ESDescriptor = util.findBox(trak, 5);
        this.audioTrakParsed = new Track(trak, mvhd);

        audioTimeScale = mdhd.timescale;
        // console.warn('audio timescale: ', audioTimeScale);
        if (esds) {
          audioCodec =
            `${codecBox.type}.` +
            util.toHex(esds.subBox[0].subBox[0].typeID) +
            `.${esds.subBox[0].subBox[0].subBox[0].type}`;
        } else {
          audioCodec = `${codecBox.type}`;
        }
        if (ESDescriptor && ESDescriptor.EScode) {
          decoderConfig = ESDescriptor.EScode.map(item => Number(`0x${item}`));
        }
        if (mp4a) {
          channelCount = mp4a.channelCount;
          sampleRate = mp4a.sampleRate;
          
          let sd = stts.entry[0].sampleDuration;
          refSampleDuration = sd / sampleRate * mvhd.timeScale;
          // console.warn('stts: ', stts.entry);
        }

        if (codec === 'hev1' || codec === 'hvc1') {
          /* ----- audio sample offset and size  开始 ------- */
          let audioSampleLen = this.audioTrakParsed.getSampleCount();
          this.audioSamples = [];

          for (let i = 0; i < audioSampleLen; i++) {
            let vo = this.audioTrakParsed.sampleToOffset(i);
            let vs = this.audioTrakParsed.sampleToSize(i, 1);
            let pts = this.audioTrakParsed.sampleToPTS(i);
            let pts_time = this.audioTrakParsed.sampleToPTSTime(i);
            let dts = this.audioTrakParsed.sampleToDTS(i);
            let dts_time = this.audioTrakParsed.sampleToDTSTime(i);
            let duration = this.audioTrakParsed.sampleDurationTime(i);
            this.audioSamples.push({
              type: 'audio',
              offset: vo,    //相对于整个流从0开始
              size: vs,
              pts: pts_time * mvhd.timeScale,
              dts: dts_time * mvhd.timeScale,
              duration: duration * mvhd.timeScale
              // pts: pts,
              // pts_time: pts_time,
              // dts: dts,
              // dts_time: dts_time
            });
          }
          /* ----- audio sample offset and size  结束 ------- */
          // console.log('audio sample info:', this.audioSamples);
          // debugger
        }
      }
    });

    this.videoTrak = Merge({}, videoTrak);
    this.audioTrak = Merge({}, audioTrak);

    let mdat = this._boxes.find(item => item.type === "mdat");
    let videoDuration = Number(
      util.seekTrakDuration(videoTrak, videoTimeScale, 'video')
    );
    let audioDuration = Number(
      util.seekTrakDuration(audioTrak, audioTimeScale, 'audio')
    );
    this.mdatStart = mdat.start;
    this.mdatSize = mdat.size;
    // let vf = this.videoKeyFrames;
    // let videoKeyFramesLength = vf.length - 1;
    // vf.forEach((item, idx) => {
    //   if (idx < videoKeyFramesLength) {
    //     this.timeRage.push([
    //       item.time.time / videoTimeScale,
    //       vf[idx + 1].time.time / videoTimeScale
    //     ]);
    //   } else {
    //     this.timeRage.push([item.time.time / videoTimeScale, -1]);
    //   }
    // });
    this.meta = {
      format: this.isMP4 ? 'mp4' : 'unknown',
      codec,
      videoCodec,
      audioCodec,
      createTime: mvhd.createTime,
      modifyTime: mvhd.modifyTime,
      duration: mvhd.duration / mvhd.timeScale,
      timeScale: mvhd.timeScale,
      videoDuration,
      videoTimeScale,
      audioDuration,
      audioTimeScale,
      endTime: Math.min(videoDuration, audioDuration),
      vps,
      sps,
      pps,
      width,
      height,
      profile,
      pixelRatio: [1, 1],
      channelCount,
      sampleRate,
      audioConfig: decoderConfig,
      fps: fps
    };
    this.audioMedia = {
      audioSampleRate: sampleRate,
      channelCount: channelCount,
      codec: audioCodec,
      config: decoderConfig,
      duration: Number(audioDuration) * 1000,
      id: audioTrakId,
      originalCodec: audioCodec,
      refSampleDuration: refSampleDuration,
      timescale: mvhd.timeScale,
      type: "audio"
    };
    // console.warn('audio media: ', this.audioMedia);
    // console.log('video elst: ', video_elst.entries);
    // console.log('audio elst: ', audio_elst.entries);
    // console.log('audio metadata: ', this.meta);
    Object.assign(this._onMediaInfo, this.meta);
    this._onMediaInfo(this._onMediaInfo);
    self.emit("moovParsed", { meta: this.meta, mdatStart: this.mdatStart });
    // console.warn('samples len: ', this.samples.length);
  }

  naluFormat(nalu_array) {
    let nalu_vps = new Uint8Array(nalu_array),
        naluVpsType = (nalu_vps[0] & 0x7E) >> 1,
        units = [];
    this._videoTrack.samples = [];
    units.push({
        data: nalu_vps,
        naluType: naluVpsType
    });
    this._videoTrack.samples.push({
        units: units,
        pts: 0,
        isDroppable: true
    });
    if (!this._onH265Segment) {
        throw new IllegalStateException('MP4Demuxer: onH265Segment callback must be specified!');
    }
    this._onH265Segment('video', this._videoTrack);
  }

  /**
   * [init 实例的初始化，主要是获取视频的MOOV元信息, 包括moov在前和后的情况]
   */
  init() {
    let self = this;
    self.getData({
        success: res => {
          let parsed;
          let moovStart = 0;
          let moov;
          let boxes;
          try {
            parsed = new Parser(res);
          } catch (e) {
            self.emit("error", e.type ? e : new Errors("parse", "", {
                    line: 176,
                    handle: "[MP4] init",
                    msg: e.message
                  })
            );
            return false;
          }
          self._boxes = boxes = parsed.boxes;
          boxes.every(item => {
            moovStart += item.size;
            if (item.type === "moov") {
              moov = item;
              self.moovBox = moov;
              self.emit("moovReady");
              return false;
            } else {
              if (item.type === "ftyp") {
                self.isMP4 = true;
              }
              return true;
            }
          });
          if (!moov) {
            let nextBox = parsed.nextBox;
            if (nextBox) {
              if (nextBox.type === "moov") {
                self
                  .getData({
                    start: moovStart,
                    end: moovStart + nextBox.size + 28,
                    success: res => {
                      let parsed = new Parser(res);
                      self._boxes = self._boxes.concat(parsed.boxes);
                      moov = parsed.boxes.filter(box => box.type === "moov");
                      if (moov.length) {
                        self.moovBox = moov[0];
                        self.emit("moovReady");
                      } else {
                        self.emit("error", new Errors("parse", "", {
                            line: 203,
                            handle: "[MP4] init",
                            msg: "not find moov box"
                          })
                        );
                      }
                    }
                  });
              } else {
                self.emit(
                  "error",
                  new Errors("parse", "", {
                    line: 207,
                    handle: "[MP4] init",
                    msg: "not find moov box"
                  })
                );
              }
            } else {
              self.getData({
                start: moovStart,
                end: "",
                success: res => {
                  let parsed = new Parser(res);
                  if (parsed) {
                    self._boxes = self._boxes.concat(parsed.boxes);
                    parsed.boxes.every(item => {
                      if (item.type === "moov") {
                        moov = item;
                        self.moovBox = moov;
                        self.emit("moovReady");
                        return false;
                      } else {
                        return true;
                      }
                    });
                  } else {
                    self.emit(
                      "error",
                      new Errors("parse", "", {
                        line: 225,
                        handle: "[MP4] init",
                        msg: "not find moov box"
                      })
                    );
                  }
                }
              });
            }
          }
        },
        error: () => {
          self.emit(
            "error",
            new Errors("network", "", {
              line: 231,
              handle: "[MP4] getData",
              msg: "getData failed"
            })
          );
        }
      });
  }

  ioComplete() {

  }

  initMetaData() {
    this.onTrackMetadata("audio", this.audioMedia);
    this._mediaInfo.hasKeyframesIndex = true;

    this.naluFormat(this._onMediaInfo.vps);
    this.naluFormat(this._onMediaInfo.sps);
    this.naluFormat(this._onMediaInfo.pps);
  }

  /**
   * 下载得到的arraybuffer数据
   */
  getArrivalData(arrayBuffer, receivedLength) {
    if (!this._onError || !this._onTrackMetadata || !this._onDataAvailable) {
      throw new IllegalStateException(
        "MP4: onError & onTrackMetadata & onDataAvailable callback must be specified"
      );
    }
    this.receivedLength = receivedLength;
    if (!this.runOnce || this.runOnce == undefined) {
      this.runOnce = true;
      this.initMetaData();
    }
    this.parseData(arrayBuffer);
  }

  parseData(arrayBuffer) {
      while (
              this.vsIndex < this.videoSamples.length && 
              (this.videoSamples[this.vsIndex].offset + this.videoSamples[this.vsIndex].size <= this.receivedLength + this.rangeFrom) &&
              !this.isSeeking
            ) {
        let sampleObj = this.videoSamples[this.vsIndex];
        let usedBufferCount = this.receivedLength - arrayBuffer.byteLength;
        sampleObj.offset = sampleObj.offset - usedBufferCount;
        this.parseVideo(arrayBuffer, sampleObj);
        this.vsIndex++;
      }
      while (
              this.asIndex < this.audioSamples.length && 
              (this.audioSamples[this.asIndex].offset + this.audioSamples[this.asIndex].size <= this.receivedLength + this.rangeFrom) && 
              !this.isSeeking
            ) {
        let sampleObj = this.audioSamples[this.asIndex];
        let usedBufferCount = this.receivedLength - arrayBuffer.byteLength;
        sampleObj.offset = sampleObj.offset - usedBufferCount;
        this.parseAudio(arrayBuffer, sampleObj);
        this.asIndex++;
      }
  }

  parseVideo(arrayBuffer, sampleObj) {
    const lengthSize = 4; //the length of nalu size
    let offset = 0, naluType, units = [];
    let sampleSize = sampleObj.size;
    let sampleOffset = sampleObj.offset - this.rangeFrom;
    let pts = sampleObj.pts;
    let dts = sampleObj.dts;
    if (pts < this.seekIdr.pts) {  //去掉下载后小于idr帧的所有视频数据，然后送给解码器进行解码
      return;
    }
    // console.log(arrayBuffer.byteLength, this.receivedLength, this.receivedLength - arrayBuffer.byteLength, sampleOffset);
    let sample = new DataView(arrayBuffer, sampleOffset, sampleSize);
    while (offset < sampleSize) {
      if (offset + lengthSize >= sampleSize) {
        Log.w(
          this.TAG,
          `Malformed Nalu near offset = ${offset}, sampleSize = ${sampleSize}`
        );
        break; // data not enough for next Nalu
      }
      let naluSize = sample.getUint32(offset);
      // if (naluSize > sampleSize - lengthSize) {
      //   // Log.w(this.TAG, 'Malformed Nalus near NaluSize > sampleSize!');
      //   return;
      // }
      if (naluSize <= sampleSize - lengthSize) {
        let nalu = new Uint8Array(
          arrayBuffer,
          sampleOffset + offset + lengthSize,
          naluSize
        );
        naluType = (nalu[0] & 0x7e) >> 1;
        // console.log('NALU Type:  ' + naluType);

        units.push({
          data: nalu,
          naluType: naluType,
          isDroppable: true
        });
        offset += lengthSize + naluSize;
      }
    }
    if (units.length) {
      let hevcSample = {
        // 视频数据结构
        units: units,
        pts: pts,
        dts: dts
      };
      this._videoTrack.samples = [];
      this._videoTrack.samples.push(hevcSample);
    }
    if (!this._onH265Segment) {
      throw new IllegalStateException(
        "MP4Demuxer: onH265Segment callback must be specified!"
      );
    }
    if (this._videoTrack.samples.length > 0) {
      this._onH265Segment("video", this._videoTrack);
    }
    // console.log('video sample length:', this.videoSamples.length);
  }

  parseAudio(arrayBuffer, sampleObj) {
    let sampleSize = sampleObj.size;
    let sampleOffset = sampleObj.offset - this.rangeFrom;
    let audio_nalu = new Uint8Array(arrayBuffer, sampleOffset, sampleSize);
    let dts = sampleObj.dts,
        pts = sampleObj.pts,
        duration = sampleObj.duration,
        track = this._audioTrack;
    let aacSample = { unit: audio_nalu, dts: dts, pts: pts, duration: duration };
    if (pts >= this.seekTime) {
      track.samples.push(aacSample);
      track.length += audio_nalu.length;
      this._onDataAvailable(this._audioTrack);
    }
    // console.log('asIndex: ', this.asIndex);
    // console.log('audio sample length:', this.audioSamples.length);
  }

  getLastSyncPointBeforePts(pts) {
    let list = this.videoKeyFrames;
    if (list.length == 0) {
        return null;
    }

    let idx = 0;
    let last = list.length - 1;
    let mid = 0;
    let lbound = 0;
    let ubound = last;

    if (pts < list[0].pts) {
        idx = 0;
        lbound = ubound + 1;
    }

    while (lbound <= ubound) {
        mid = lbound + Math.floor((ubound - lbound) / 2);
        if (mid === last || (pts >= list[mid].pts && pts < list[mid + 1].pts)) {
            idx = mid;
            break;
        } else if (list[mid].pts < pts) {
            lbound = mid + 1;
        } else {
            ubound = mid - 1;
        }
    }
    return list[idx];
  }


  seek(milliseconds = 0) {
    this.seekTime = milliseconds;
    this.isSeeking = true;
    // console.log('videoSamples: ', this.videoSamples);
    // console.log('audioSamples: ', this.audioSamples);

    let idr = this.getLastSyncPointBeforePts(milliseconds);
    this.seekIdr = idr;
    let idr_audioFrame = null;
    // console.log('idr: ', idr);
    this.videoSamples.every((item, index) => {
      if (item.offset == idr.offset) {  
        this.vsIndex = index;
        return false;
      }
      return true;
    });
    this.audioSamples.every((item, index) => {

      if (item.pts >= idr.pts) {
        this.asIndex = index;
        return false;
      }
      return true;
    });
    // console.log('vs: ', this.vsIndex, this.videoSamples[this.vsIndex]);
    // console.log('as: ', this.asIndex, this.audioSamples[this.asIndex]);

    idr_audioFrame = this.audioSamples[this.asIndex];  //idr之前最近的pts

    let pos = idr.offset - idr_audioFrame.offset > 0 ? idr_audioFrame.offset : idr.offset;
    this.rangeFrom = pos;

    // this.transCtlEvent.emit('transCtlEvent-seekTime',{ seekTime: before_idr_audioFrame.pts / 1000, position: this.rangeFrom });
    // console.log('vsindex, asindex: ', this.vsIndex, this.asIndex, before_idr_audioFrame);
    return {
      idr: idr,
      position: pos,
      seekTime: milliseconds / 1000
    }
  }

  updateSeekState () {
    this.isSeeking = false;
    // console.log('------- update seek state -------');
  }

  get videoKeyFrames () {
    if (this._videoFrames) {
      return this._videoFrames;
    }
    let videoTrak = this.videoTrak;
    let stss = util.findBox(videoTrak, 'stss');   //关键帧位置

    // let frames = this.getSamplesByOrders('video', stss.entries.map(item => item - 1));
    let frames = [];
    stss.entries.forEach((item, index) => {
      let i = item - 1;
      let vo = this.videoTrakParsed.sampleToOffset(i);
      let vs = this.videoTrakParsed.sampleToSize(i, 1);
      let pts = this.videoTrakParsed.sampleToPTSTime(i);
      let dts = this.videoTrakParsed.sampleToDTSTime(i);
      frames.push({
        type: 'video',
        idx: index,
        offset: vo,
        size: vs,
        pts: pts * this.meta.timeScale,
        dts: dts * this.meta.timeScale
      })
    });
    this._videoFrames = frames;
    return frames;
  }

  // get audioKeyFrames () {
  //   if (this._audioFrames) {
  //     return this._audioFrames
  //   }
  //   let videoScale = util.findBox(this.videoTrak, 'mdhd').timescale;
  //   let audioScale = util.findBox(this.audioTrak, 'mdhd').timescale;
  //   let audioStts = util.findBox(this.audioTrak, 'stts').entry;
  //   let videoFrames = this.videoKeyFrames;
  //   let audioIndex = [];
  //   audioIndex = videoFrames.map(item => {
  //     return util.seekOrderSampleByTime(audioStts, audioScale, item.time.time / videoScale);
  //   })
  //   this._audioFrames = audioIndex;
  //   return this._audioFrames;
  // }

  getSamplesByOrders(type = "video", start, end) {
    let trak = type === "video" ? this.videoTrak : this.audioTrak;
    let stsc = util.findBox(trak, "stsc"); // chunk~samples
    let stsz = util.findBox(trak, "stsz"); // sample-size
    let stts = util.findBox(trak, "stts"); // sample-time
    let stco = util.findBox(trak, "stco"); // chunk-offset
    let ctts = util.findBox(trak, "ctts"); // offset-compositime
    let timeScale = util.findBox(trak, 'mdhd').timescale;
    let mdatStart = this.mdatStart;
    let samples = [];    //储存关键帧的信息 idx: sample索引, size: sample size, time: {dts, pts}, offset: 相对于mdat box的偏移量
    end = end !== undefined ? end : stsz.entries.length;
    if (start instanceof Array) {
      start.forEach((item, idx) => {
        samples.push({
          idx: item,
          size: stsz.entries[item],
          time: util.seekSampleTime(stts, ctts, item, timeScale),
          offset: util.seekSampleOffset(stsc, stco, stsz, item, 0)
          // offset: util.seekSampleOffset(stsc, stco, stsz, item, mdatStart)
        });
      });
    } else if (end !== 0) {
      for (let i = start; i < end; i++) {
        samples.push({
          idx: i,
          size: stsz.entries[i],
          time: util.seekSampleTime(stts, ctts, i, timeScale),
          offset: util.seekSampleOffset(stsc, stco, stsz, i, 0)
          // offset: util.seekSampleOffset(stsc, stco, stsz, i, mdatStart)
        });
      }
    } else {
      samples = {
        idx: start,
        size: stsz.entries[start],
        time: util.seekSampleTime(stts, ctts, start, timeScale),
        offset: util.seekSampleOffset(stsc, stco, stsz, start, 0)
        // offset: util.seekSampleOffset(stsc, stco, stsz, start, mdatStart)
      };
    }
    return samples;
  }

  get onH265Segment() {
    return this._onH265Segment;
  }

  set onH265Segment(callback) {
    this._onH265Segment = callback;
  }

  get onDataAvailable() {
    return this._onDataAvailable;
  }

  set onDataAvailable(callback) {
    this._onDataAvailable = callback;
  }

  get onTrackMetadata() {
    return this._onTrackMetadata;
  }

  set onTrackMetadata(callback) {
    this._onTrackMetadata = callback;
  }

  get onMediaInfo() {
      return this._onMediaInfo;
  }

  set onMediaInfo(callback) {
      this._onMediaInfo = callback;
  }

  get onError() {
    return this._onError;
  }

  set onError(callback) {
    this._onError = callback;
  }
}

export default MP4;
