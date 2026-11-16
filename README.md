# 定位校正源的基站身份与历元接收

校正源原件接收。网关保留 NTRIP 授权会话和 RTCM3 字节分片；不做定位求解。字节收存之上增加 RTCM3 观测接收：帧边界与 CRC24Q 校验、消息类型识别、基站定义与观测历元关联，结果作为独立观测投影保存。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件与观测关联结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /observations 返回观测投影（基站、历元、未关联消息、缺陷），GET /health 检查服务。

```sh
docker build --network=none -t correction-stream .
docker run --rm --network=none correction-stream npm test
docker run --rm --network=none correction-stream npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。collect 返回原件行，collectSession 额外保留挂载点、连接与 eof 领取上下文。
- src/rtcm3.mjs 是 RTCM3 帧层：CRC24Q、有界重找帧、位读取、1005/1006 与 MSM(1071-1137) 头解码。只有完整帧头加校验通过的字节才算可信帧。
- src/correlate.mjs 把可信帧关联成基站定义与观测历元：站身份按连接加站号加坐标版本区分，历元按消息内时间分组并处理跨周回滚，质量分为 ok/degraded/unknown，资料不齐时不报正常。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。观测投影单独存放在 observations 子目录，与原件归档各自维护。
- src/api.mjs 提供收件与观测查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
