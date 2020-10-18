# MSE播放fmp4示例

## 流程
1. 使用fetch range请求mp4 -> arraybuffer
2. 如果sourceBuffer正在updating，则将buffer放入队列，否则直接mediaSource.appendBuffer
3. sourceBuffer触发updateend后（处理appendBuffer就会是updating）再从队列中取第一个buffer
4. fetch最后如果还未请求完数据则递归请求（改变range的起始值）

## 其他
1. MSE必须使用fmp4，如果不是可以使用mp4fragment（https://www.bento4.com/documentation/mp4info/）转下

```shell
mp4fragment source.mp4 target.mp4
```

如果使用普通mp4会报

```
Failed to execute 'endOfStream' on 'MediaSource': The MediaSource's readyState is not 'open'
```

2. 创建sourceBuffer的codec必须是下载视频codec，同样可以使用mp4info工具查看

```shell
mp4 example.mp4 | grep Codec

# ->> 输出
# Codecs String: avc1.640828
# Codecs String: mp4a.40.2
```

3. 项目启动

**不要**使用parcel，可能拉流不正确
可以使用任一http-server工具
