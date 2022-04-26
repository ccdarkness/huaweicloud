# huaweicloud
华为云空间云盘同步备份工具

## 介绍
开发初衷：华为云空间云盘目前只有官方客户端，PC和安卓版本，而我的数据存在群晖NAS上，想自动备份的华为云盘就开发了这个客户端
适用于NAS、linux、mac、pc等多平台

## 使用方法
1.安装node.js https://nodejs.org/en/

2.下载本程序h.js 和 package.json 到本地

3.在程序所在文件夹中打开命令行执行 npm install 安装需要用到的模块

4.打开h.js进行配置
````
const MY_APP_NAME = 'BREAD-NAS';//网盘文件夹的名称

const MY_APP_LOCAL = "e:\\hiHuaweiCloud";//本地网盘文件夹路径 ** 如果文件同步后再次改路径请删除h.js同目录下的.h.db数据库，否则导致文件被删除 **
````
5.运行node h.js即可在华为云盘根目录新建MY_APP_NAME文件夹，并与本地MY_APP_LOCAL文件夹中的文件进行双向同步

6.第一次运行后会显示一个URL，请复制粘贴到浏览器运行，获取云盘授权

7.授权后会跳转到github项目页面，复制整个url到命令行粘贴，url里面含有授权码

8.运行后系统开始云盘和本地文件夹同步，同步完毕后程序自动退出，下次需要同步则再次运行


## 各文件状态对应的同步操作
1. 本地有，云盘无，【上传到云盘】
2. 本地无，云盘有，【下载到本地】
3. 本地删除，云盘有，【删除云盘文件】
4. 本地有，云盘删除，【删除本地文件】`当一个文件在本地有而云盘没有的时候，如何判断要删除还是上传，
主要看本地数据库是否有对应记录和最后同步时间，如本地文件fileA，在数据库有最后同步记录，而现在程序运行比较后发现云盘没有了，则表示需要删除本地文件
`
5. 本地修改，云盘未改，【上传到云盘】
6. 本地未改，云盘修改，【下载到本地】
7. 本地改名，云盘未改，【更新云盘文件名】todo: 程序遇到改名问题会报错，还待优化
7. 本地未改，云盘改名，【更新本地文件名】


## 参考文档
https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/web-get-access-token-0000001050048946

https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/server-dev-process-0000001064314366

https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/server-managing-and-searching-0000001064818926#section775911189449

https://developer.huawei.com/consumer/cn/doc/development/HMSCore-References/server-api-fileslist-0000001050153649
