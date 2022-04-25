# huaweicloud
华为云空间云盘同步备份工具

## 介绍
开发初衷：华为云空间云盘目前只有官方客户端，PC和安卓版本，而我的数据存在群晖NAS上，想自动备份的华为云盘就开发了这个客户端
适用于NAS、linux、mac、pc等多平台

## 使用方法
1. 安装node.js https://nodejs.org/en/
2. 下载本程序h.js 和 package.json 到本地
3. 在程序所在文件夹中打开命令行执行 npm install 安装需要用到的模块
4. 打开h.js进行配置
const MY_APP_NAME = 'BREAD-NAS';//网盘文件夹的名称
const MY_APP_LOCAL = "e:\\hiHuaweiCloud";//本地网盘文件夹路径
5. 运行node h.js即可在华为云盘根目录新建MY_APP_NAME文件夹，并与本地MY_APP_LOCAL文件夹中的文件进行双向同步
