/*
参考文档：
https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/web-get-access-token-0000001050048946
https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/server-dev-process-0000001064314366
https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/server-managing-and-searching-0000001064818926#section775911189449
https://developer.huawei.com/consumer/cn/doc/development/HMSCore-References/server-api-fileslist-0000001050153649
*/

let READLINE = require('readline');
let URL = require('url');
let HTTPS = require('https');
let FS = require('fs');
let PATH = require('path');
let QS = require('querystring');
const CRYPTO = require('crypto');
const ASYNCMUTEX = require('async-mutex').Mutex;
let LOCKER = new ASYNCMUTEX();//创建一个互斥锁，防止多个线程读写数组导致错误
const DB = require('better-sqlite3')('.h.db');

const MY_APP_NAME = 'BREAD-NAS';//网盘文件夹的名称
const MY_APP_LOCAL = "e:\\hiHuaweiCloud";//本地网盘文件夹路径
let MY_APP_ID = '';//网盘文件夹ID
const CLIENT_ID = '105816847';//应用程序ID
const CLIENT_SECRET = '9dbef5edebd2dfec86700bc27ae606039d5d8cfe08a0206a48f05159d738a386';//应用程序安全码
const REDIRECT_URI = 'https://github.com/ccdarkness/huaweicloud';//授权回调站点，是为了获取code
const SCOPE = 'openid+profile+https://www.huawei.com/auth/drive.file';//应用需要申请的权限  https://developer.huawei.com/consumer/cn/doc/development/HMSCore-Guides/server-obtain-authentication_info-0000001064659348
//code的URL拼接
const AUTHORIZE_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize?'
    + 'response_type=code&access_type=offline&state=ccdarkness_huaweicloud'
    + '&client_id=' + CLIENT_ID
    + '&redirect_uri=' + REDIRECT_URI
    + '&scope=' + SCOPE;
let AUTHORIZE_CODE = '';
const ACCESS_TOKEN_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token?grant_type=authorization_code'
    + '&client_id=' + CLIENT_ID
    + '&client_secret=' + CLIENT_SECRET
    + '&redirect_uri=' + REDIRECT_URI
    + '&code=';

let ACCESS_TOKEN = '';//token
let ACCESS_TOKEN_REFRESH = '';//刷新的token，保持不过期

let ACCESS_TOKEN_FILE = 'ACCESS_TOKEN.DATA';
const MAX_UPLOAD_SIZE = 1024 * 1024 * 20;//单次上传尺寸，也是断点续传切片
let DOWN_LIST = [];
let DOWN_LIST_NUMBER = 6;//下载线程数
let DOWN_INTERVAL;//定时器
//get_file_list_local(MY_APP_LOCAL);
main();

//console.log( URL.parse('https://driveapis.cloud.huawei.com.cn/upload/drive/v1/files/DSQpEkxcAAADKXEPJAYABgEZivNwAmCu?uploadType=resume&fields=*'));


//入口函数
async function main() {
    create_table();

    if (!FS.existsSync(MY_APP_LOCAL)) {
        mkdirP(MY_APP_LOCAL);
    }

    if (FS.existsSync(ACCESS_TOKEN_FILE)) {
        await load_token_data();
    } else {
        await get_token_data();
    }


    await goto_home();//在这里开始遍历目录

    DOWN_INTERVAL = setInterval(function () {
        do_transfer();
        for (down of DOWN_LIST) {
            console.log(`传输队列:${down.t_type} ${down.t_id} id:${down.t_f_id} ${down.t_file_path}`);
        }
    }, 20000);
}


function create_table() {
    let sql = `
        CREATE TABLE IF NOT EXISTS
        "fileinfos" (
            "id" TEXT,
            "fileName" TEXT,
            "mimeType" TEXT,
            "parentFolder" TEXT,
            "createdTime" TEXT,
            "editedTime" TEXT,
            "editedTimeMS" INTEGER,
            "syncTimeMS" INTEGER DEFAULT 0,
            "size" INTEGER,
            "sha256" TEXT,
            "version" INTEGER
        );
        
        CREATE TABLE IF NOT EXISTS
        "fileinfos_temp" (
            "id" TEXT,
            "fileName" TEXT,
            "mimeType" TEXT,
            "parentFolder" TEXT,
            "createdTime" TEXT,
            "editedTime" TEXT,
            "editedTimeMS" INTEGER,
            "size" INTEGER,
            "sha256" TEXT,
            "version" INTEGER
        );
        
        CREATE TABLE IF NOT EXISTS
        "transfer_list" (
        "t_id" INTEGER NOT NULL UNIQUE,
        "t_f_id" TEXT,
        "t_type" TEXT,
        "t_url" TEXT,
        "t_start" INTEGER,
        "t_end" INTEGER,
        "t_total" INTEGER,
        "t_parentFolder" TEXT,
        "t_file_path" TEXT,
        "t_info" TEXT,
        "t_mimeType" TEXT,
        "t_filename" TEXT,
        PRIMARY KEY("t_id" AUTOINCREMENT)
        );

        DELETE FROM fileinfos_temp;
    `;
    DB.exec(sql);
}

//获取授权文件
function get_token_data() {
    //授权请求URL
    console.log('复制以下地址到浏览器中获取授权：');
    console.log(AUTHORIZE_URL);

    //等待输入授权后的URL
    let readline_get_token_url = READLINE.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve, reject) => {
        readline_get_token_url.question('粘贴授权URL：', function (answer) {
            let authorize_code_url = URL.parse(answer.replace('#', '?'), true).query;
            readline_get_token_url.close();
            AUTHORIZE_CODE = authorize_code_url.code;
            //使用POST来请求token
            let post_data = QS.stringify({
                grant_type: 'authorization_code',
                code: AUTHORIZE_CODE,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI
            });
            let options = {
                hostname: 'oauth-login.cloud.huawei.com',
                port: 443,
                path: '/oauth2/v3/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(post_data, 'utf8')
                }
            };

            let req = HTTPS.request(options, (res) => {
                let _data = '';
                res.on('data', (chunk) => {
                    _data += chunk;
                });
                res.on('end', function () {
                    const access_token_json = JSON.parse(_data);
                    if (access_token_json.error) {//说明有错误，显示出来
                        console.log(access_token_json);
                        get_token_data();//再次请求授权
                    } else {
                        FS.writeFileSync(ACCESS_TOKEN_FILE, _data);//保存授权信息
                        ACCESS_TOKEN_REFRESH = access_token_json.refresh_token;
                        ACCESS_TOKEN = access_token_json.access_token;
                        console.log('获取授权成功。。。');
                        resolve(_data);
                    }
                });
            });
            req.on('error', reject);
            req.write(post_data);
            req.end();
        });
    })
}

//读取授权文件
function load_token_data() {
    const access_token_data = FS.readFileSync(ACCESS_TOKEN_FILE);
    const access_token_json = JSON.parse(access_token_data);
    if (access_token_json.error) {//说明有错误，显示出来
        console.log(access_token_json);
        get_token_data();
        return;
    } else {
        console.log('读取授权文件成功。。。');
        ACCESS_TOKEN_REFRESH = access_token_json.refresh_token;
    }

    //获取最新的token，用refresh_token去刷新
    let post_data = QS.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: ACCESS_TOKEN_REFRESH
    });
    let options = {
        hostname: 'oauth-login.cloud.huawei.com',
        port: 443,
        path: '/oauth2/v3/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(post_data, 'utf8')
        }
    };
    return new Promise((resolve, reject) => {
        let req = HTTPS.request(options, (res) => {
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', function () {
                const access_token_json = JSON.parse(_data);
                if (access_token_json.error) {//说明有错误，显示出来
                    console.log(access_token_json);
                    get_token_data();//再次请求授权
                } else {
                    console.log('获取授权成功。。。');
                    FS.writeFileSync(ACCESS_TOKEN_FILE, _data);//保存授权信息
                    ACCESS_TOKEN_REFRESH = access_token_json.refresh_token;
                    ACCESS_TOKEN = access_token_json.access_token;
                    resolve(_data);
                }
            });
        });
        req.on('error', reject);
        req.write(post_data);
        req.end();
    })
}


//调用接口，测试一下链接是否成功
async function goto_home() {
    const options = {
        hostname: 'driveapis.cloud.huawei.com.cn',
        path: '/drive/v1/about?fields=*',
        headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
    }
    return new Promise((resolve, reject) => {
        let req = HTTPS.get(options, (res) => {
            let _data = '';
            res.on('data', function (chunk) {
                _data += chunk;
            });
            res.on('end', async function () {
                const data_json = JSON.parse(_data);
                if (data_json.error) {//说明有错误，显示出来
                    console.log(data_json);
                    reject(data_json);
                } else {
                    console.log('\n'
                        + '用户:' + data_json.user.displayName
                        + '\n容量(已用/总容量):' + parseInt(data_json.storageQuota.usedSpace / (1024 * 1024 * 1024)) + ' Gb/' + parseInt(data_json.storageQuota.userCapacity / (1024 * 1024 * 1024)) + ' Gb'
                        + '\n最大上传尺寸:' + parseFloat(data_json.maxFileUploadSize / (1024 * 1024 * 1024)).toFixed(2) + ' Gb'
                    );
                    //获取网盘根目录文件，用来找到主目录
                    let files_data = await get_file_list(false, '', "'root' in parentFolder and fileName='" + MY_APP_NAME + "' ");// "'root' in parentFolder"
                    console.log('获取主目录');
                    if (files_data.length === 0) {//为空的话就创建目录
                        console.log('创建主目录');
                        let folderOBJ = JSON.stringify({
                            fileName: MY_APP_NAME,
                            description: 'ccdarkness hi huawei cloud',
                            mimeType: "application/vnd.huawei-apps.folder",
                            parentFolder: ['root']
                        });
                        const file_info = await create_folder(folderOBJ);
                        MY_APP_ID = file_info.id;
                    } else {
                        MY_APP_ID = files_data[0].id;
                    }
                    console.log('遍历主目录:' + MY_APP_ID);
                    await get_file_list(true, '', "'" + MY_APP_ID + "' in parentFolder");
                    console.log('遍历结束');
                    merge_table();//合并数据库
                    merge_file(MY_APP_ID, MY_APP_LOCAL);//合并云和本地文件的差异
                    resolve(MY_APP_ID);
                }
            });
        });
        req.on('error', reject);
        req.end();
    })
}

function insertData(filelist, in_temp = true) {
    let table_name = in_temp ? 'fileinfos_temp' : 'fileinfos';
    let insertManyData = [];
    if (filelist.length === 0) {
        return false;
    }
    filelist.map(file => {
        console.log('发现:' + file.fileName);
        insertManyData.push({
            id: file.id,
            fileName: file.fileName,
            mimeType: file.mimeType,
            createdTime: file.createdTime,
            size: file.size,
            sha256: file.sha256,
            parentFolder: file.parentFolder.toString(),
            editedTime: file.editedTime,
            editedTimeMS: new Date(file.editedTime).getTime(),//换成时间戳，方便比较
            version: file.version
        })
    });
    const insert = DB.prepare(`INSERT INTO ${table_name} (id,fileName, mimeType,createdTime,size,sha256,parentFolder,editedTime,editedTimeMS,version) VALUES (@id,@fileName, @mimeType,@createdTime,@size,@sha256,@parentFolder,@editedTime,@editedTimeMS,@version)`);
    const insertMany = DB.transaction((files) => {
        for (const file of files) insert.run(file);
    });
    insertMany(insertManyData);
}

//合并temp表到正式表，作用是排查是否有文件变动
//  temp表比正式表多，云服务器新增文件，把新记录插入正式表，状态设为新增
//  temp表比正式表少，云服务器删除文件，在正式表中标记状态为删除，等物理删除后再删除记录
//  相同记录的需要比较版本号、文件尺寸、修改时间、父路径是否一致，状态设置为更新
function merge_table() {
    let sql = `INSERT INTO fileinfos(id,fileName,mimeType,parentFolder,createdTime,editedTime,editedTimeMS,size,sha256,version)
  SELECT id,fileName,mimeType,parentFolder,createdTime,editedTime,editedTimeMS,size,sha256,version
   FROM fileinfos_temp ft WHERE NOT EXISTS (SELECT 1 FROM fileinfos f WHERE f.id=ft.id );`;
    DB.exec(sql);
    sql = `
        INSERT INTO transfer_list (t_f_id,t_type,t_parentFolder,t_mimeType,t_filename) 
           SELECT id,'delete_local',parentFolder,mimeType,fileName FROM fileinfos
           where NOT EXISTS (SELECT 1 FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id );
        `;//在传输列表里面添加删除记录
    DB.exec(sql);
    sql = `DELETE FROM fileinfos where NOT EXISTS (SELECT 1 FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id );`;//删除列表中记录
    DB.exec(sql);
    sql = `
                  UPDATE fileinfos SET editedTime=(SELECT editedTime FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id  limit 0,1)
                  ,editedTimeMS=(SELECT editedTimeMS FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id  limit 0,1)
                  ,size=(SELECT size FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id  limit 0,1)
                  ,version=(SELECT version FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id  limit 0,1)
                  ,sha256=(SELECT sha256 FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id  limit 0,1)
                  ,parentFolder=(SELECT parentFolder FROM fileinfos_temp WHERE fileinfos_temp.id=fileinfos.id  limit 0,1)
                    WHERE EXISTS 
                        (SELECT 1
                        FROM fileinfos_temp
                        WHERE fileinfos_temp.id=fileinfos.id
                            AND (fileinfos_temp.editedTime!=fileinfos.editedTime
                            OR fileinfos_temp.size!=fileinfos.size
                            OR fileinfos_temp.version!=fileinfos.version
                            OR fileinfos_temp.sha256!=fileinfos.sha256
                            OR fileinfos_temp.parentFolder!=fileinfos.parentFolder ) );
                      `;
    DB.exec(sql);
    console.log('数据合并完毕');
}


//获取文件列表
//traversal 是否遍历目录
//cursor当前页游标，由前一个响应的nextCursor获取,如果游标存在着表示需要继续继续查询
//queryParam 查询语句  "'root' in parentFolder" 查询根目录
async function get_file_list(traversal = false, cursor = '', queryParam = '') {
    let query = ''
    if (cursor) {
        query += '&cursor=' + cursor;
    }
    if (queryParam) {
        query += '&queryParam=' + encodeURIComponent(queryParam);
    }
    const options = {
        hostname: 'driveapis.cloud.huawei.com.cn',
        path: "/drive/v1/files?fields=*&pageSize=100" + query,
        headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
    }

    const return_data = await new Promise((resolve, reject) => {
        let req = HTTPS.get(options, (res) => {
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', () => {
                let data_json = JSON.parse(_data);
                if (data_json.error) {//说明有错误，显示出来
                    console.log(data_json);
                    reject(data_json);
                } else {
                    resolve(data_json);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });

    insertData(return_data.files);

    if (return_data.nextCursor) {//如果游标存在则表示还需要进一步查询
        await get_file_list(traversal, return_data.nextCursor, queryParam);
    }

    if (traversal && return_data.files.length !== 0) { //遍历目录
        for (let i = 0; i < return_data.files.length; i++) {
            if (return_data.files[i].mimeType == 'application/vnd.huawei-apps.folder') {
                await get_file_list(traversal, '', `'${return_data.files[i].id}' in parentFolder`);
            }
        }
    }
    return return_data.files;
}

function delete_folder(path) {
    let files = [];
    if (FS.existsSync(path)) {
        files = FS.readdirSync(path);
        files.forEach(function (file, index) {
            let curPath = PATH.join(path, file);
            if (FS.statSync(curPath).isDirectory()) {
                delete_folder(curPath);
            } else {
                FS.unlinkSync(curPath);
            }
        });
        FS.rmdirSync(path);
    }
}

//处理合并
async function merge_file(folder_id, local_path) {
    mkdirP(local_path);
    //先处理本地删除任务，否则在会发现本地有文件而云端没有就变上传了
    const query_transfer = DB.prepare(`SELECT * FROM transfer_list WHERE t_parentFolder= ? AND t_type='delete_local';`).all(folder_id);
    for (let transfer of query_transfer) {
        let full_filename = PATH.join(local_path, transfer.t_filename);
        if (FS.existsSync(full_filename)) {
            if (transfer.t_mimeType == 'application/vnd.huawei-apps.folder' && FS.statSync(full_filename).isDirectory()) {
                delete_folder(full_filename);
            } else {
                FS.unlinkSync(full_filename);
            }
        }
    }

    const query = DB.prepare('SELECT * FROM fileinfos WHERE parentFolder= ?');//一个查询语句对象
    const db_file_list = query.all(folder_id)//执行查询
    const local_file_list = FS.readdirSync(local_path);
    let update_info_list = [];
    let transfer_list = [];//传输队列
    let insert_list = [];//添加的文件列表

    //处理云端有的文件
    for (let db_item of db_file_list) {
        let full_path = PATH.join(local_path, db_item.fileName);
        let find_item = false;
        local_file_list.forEach((loc_item) => {
            if (find_item === false && db_item.fileName == loc_item) {
                let file_stat = FS.statSync(full_path);
                if (file_stat.isDirectory() == (db_item.mimeType == 'application/vnd.huawei-apps.folder')) {//判断文件类型要一致，文件夹和文件可能重名
                    find_item = {fileName: loc_item, stat: file_stat};
                }
            }
        });

        if (find_item) {//云文件有，本地有
            if (db_item.mimeType !== 'application/vnd.huawei-apps.folder') {//如果是文件
                let file_hash256 = hash256(full_path);
                if (db_item.editedTimeMS > db_item.syncTimeMS && file_hash256 !== db_item.sha256) {//云文件的修改时间大于最后同步时间，则下载
                    console.log('下载(云地):' + db_item.editedTimeMS + '|' + db_item.syncTimeMS + ' ' + hash256(full_path) + '|' + db_item.sha256 + ' ' + find_item.fileName);
                    transfer_list.push({
                        t_f_id: db_item.id,
                        t_type: 'download',
                        t_parentFolder: folder_id,
                        t_file_path: full_path,
                        t_info: ''
                    });
                } else if (db_item.size !== find_item.stat.size || file_hash256 !== db_item.sha256) {//先判断文件大小，文件不一样就不用计算sha256了
                    //云端有的文件不能直接上传覆盖，只能更新上传
                    console.log('更新:' + db_item.size + '|' + find_item.stat.size + ' ' + db_item.sha256 + '|' + file_hash256 + ' ' + find_item.fileName + '|' + full_path);//上传到服务器
                    //console.log('更新:' + find_item.fileName);
                    transfer_list.push({
                        t_f_id: db_item.id,
                        t_type: 'update',
                        t_parentFolder: folder_id,
                        t_file_path: full_path,
                        t_info: JSON.stringify({sha256: file_hash256, editedTime: new Date().toISOString()})
                    });
                } else {
                    update_info_list.push({id: db_item.id, syncTimeMS: Date.now()});
                }
            } else {//文件夹则进入循环
                merge_file(db_item.id, full_path);
                update_info_list.push({id: db_item.id, syncTimeMS: Date.now()});
            }

        } else {//云文件有，本地没有
            if (db_item.editedTimeMS < db_item.syncTimeMS) { //如果同步时间大于编辑时间，说明本地下载过，然后删除了，需要删除云端文件
                transfer_list.push({
                    t_f_id: db_item.id,
                    t_type: 'delete',
                    t_parentFolder: folder_id,
                    t_file_path: full_path,
                    t_info: ''
                });
            } else {
                console.log('下载(云):' + db_item.fileName);
                if (db_item.mimeType !== 'application/vnd.huawei-apps.folder') {//下载到本地
                    transfer_list.push({
                        t_f_id: db_item.id,
                        t_type: 'download',
                        t_parentFolder: folder_id,
                        t_file_path: full_path,
                        t_info: ''
                    });
                } else {//如果是目录，则创建
                    mkdirP(PATH.join(local_path, db_item.fileName));
                    merge_file(db_item.id, full_path);
                    update_info_list.push({id: db_item.id, syncTimeMS: Date.now()});
                }
            }
        }
    }

    //处理云端没有，本地有的文件
    for (let loc_item of local_file_list) {
        let full_path = PATH.join(local_path, loc_item);
        let file_stat = FS.statSync(full_path);
        let find_item = false;
        db_file_list.forEach((db_item) => {
            if (db_item.fileName == loc_item) {
                if (file_stat.isDirectory() == (db_item.mimeType == 'application/vnd.huawei-apps.folder')) {//判断文件类型要一致，文件夹和文件可能重名
                    find_item = {fileName: loc_item, stat: file_stat};
                }
            }
        });

        if (find_item === false) {//只处理找不到的情况，找到的情况在云端有本地有的过程中处理过了
            if (file_stat.isDirectory()) {//如果是目录
                let folderOBJ = JSON.stringify({
                    fileName: loc_item,
                    mimeType: "application/vnd.huawei-apps.folder",
                    parentFolder: [folder_id]
                });
                const file_info = await create_folder(folderOBJ);
                insert_list.push({
                    id: file_info.id,
                    fileName: file_info.fileName,
                    mimeType: file_info.mimeType,
                    createdTime: file_info.createdTime,
                    size: file_info.size,
                    sha256: file_info.sha256,
                    parentFolder: file_info.parentFolder.toString(),
                    editedTime: file_info.editedTime,
                    editedTimeMS: new Date(file_info.editedTime).getTime(),//换成时间戳，方便比较
                    version: file_info.version,
                })
                merge_file(file_info.id, full_path);
            } else {
                //添加到传输队列
                console.log('上传文件:' + full_path);
                transfer_list.push({
                    t_f_id: '',
                    t_type: 'upload',
                    t_parentFolder: folder_id,
                    t_file_path: full_path,
                    t_info: ''
                });
            }
        }
    }

    insertData(insert_list, false);

//更新文件信息
    const update = DB.prepare('UPDATE fileinfos SET syncTimeMS=@syncTimeMS WHERE id=@id');
    const updateMany = DB.transaction((datas) => {
        for (const data of datas) update.run(data);
    });
    updateMany(update_info_list);

    //清空当前需要删除的传输列表
    DB.prepare(`delete from transfer_list WHERE t_parentFolder= ? AND t_type='delete_local'`).run(folder_id);

//把传输列表写入数据库
    const insert = DB.prepare('INSERT INTO transfer_list (t_f_id,t_type,t_parentFolder,t_file_path,t_info) SELECT @t_f_id,@t_type,@t_parentFolder,@t_file_path,@t_info WHERE NOT EXISTS (select 1 from transfer_list where t_file_path=@t_file_path AND t_file_path is not NULL  LIMIT 0,1 )');
    const insertMany = DB.transaction((transfers) => {
        for (const transfer of transfers) insert.run(transfer);
    });
    insertMany(transfer_list);


}

function download(file_id, file_path) {
    const options = {
        hostname: 'driveapis.cloud.huawei.com.cn',
        path: `/drive/v1/files/${file_id}?form=content`,
        headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
    }

    return new Promise((resolve, reject) => {
        let req = HTTPS.get(options, (res) => {
            //console.log(res.headers);
            res.setEncoding("binary");
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', () => {
                FS.writeFileSync(file_path, _data, 'binary');//保存文件
                DB.prepare(`UPDATE fileinfos SET syncTimeMS=@syncTimeMS WHERE id=@id; `).run({
                    id: file_id,
                    syncTimeMS: Date.now()
                });//如果有记录则更新，没有则等下次同步
                resolve(_data);
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

function create_upload(fileOBJ, file_steam_length, content_type) {
    let options = {
        hostname: 'driveapis.cloud.huawei.com.cn',
        port: 443,
        path: `/upload/drive/v1/files?uploadType=resume`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Content-Length': Buffer.byteLength(fileOBJ, 'utf8'),
            'X-Upload-Content-Type': content_type,
            'X-Upload-Content-Length': file_steam_length,
            'Authorization': 'Bearer ' + ACCESS_TOKEN
        }
    };
    //console.log(options);
    return new Promise((resolve, reject) => {
        let req = HTTPS.request(options, (res) => {
            // console.log('headers:', res.headers);
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', function () {
                let data_json = JSON.parse(_data);
                if (data_json.error) {//说明有错误，显示出来
                    console.log(data_json);
                    reject(data_json);
                } else {
                    resolve(res.headers);//返回这个，用来或者续传url：location
                }
            });
        });
        req.on('error', reject);
        req.write(fileOBJ);
        req.end();
    });
}

async function upload(transfer) {
    if (FS.existsSync(transfer.t_file_path)) {
        let file_steam = FS.readFileSync(transfer.t_file_path);
        let extname = PATH.extname(transfer.t_file_path);
        let content_type = MIMETYPES[extname] ? MIMETYPES[extname] : MIMETYPES['def'];
        if (!transfer.t_url) {//如果没有上传URL，就需要创建续传url
            let fileOBJ = JSON.stringify({
                fileName: PATH.basename(transfer.t_file_path),
                parentFolder: [transfer.t_parentFolder]
            });
            if (transfer.t_f_id) {//t_f_id有值表示是更新文件，留空是上传新文件
                transfer.t_url = `https://driveapis.cloud.huawei.com.cn/upload/drive/v1/files/${transfer.t_f_id}?uploadType=resume&fields=*`;
                let update_resume = await _upload(transfer.t_url, transfer.t_info, 0, file_steam.length, file_steam.length, content_type, true);
                transfer.t_url = update_resume.headers.location;
            } else {
                let upload_resume = await create_upload(fileOBJ, file_steam.length, content_type);//创建断点续传
                transfer.t_url = upload_resume.location;
            }
            transfer.t_start = 0;
            transfer.t_end = file_steam.length < MAX_UPLOAD_SIZE ? file_steam.length : MAX_UPLOAD_SIZE;
            transfer.t_total = file_steam.length;
        } else {//根据已经上传的记录来计算下一次上传的片段
            if (transfer.t_end !== transfer.t_total) {//如果终点等于全部，表示已经成功上传了，需要再根据上次content range范围请求一次才能返回成功
                transfer.t_start = transfer.t_end;//起点就是上次传送的终点
                transfer.t_end = (transfer.t_total - transfer.t_end - 1) < MAX_UPLOAD_SIZE ? transfer.t_total : MAX_UPLOAD_SIZE + transfer.t_end;
            }
        }
        console.log('正在上传:' + `s:${transfer.t_start} e:${transfer.t_end} t:${transfer.t_total}  ${transfer.t_file_path}`);
        _upload(transfer.t_url, file_steam, transfer.t_start, transfer.t_end, transfer.t_total, content_type).then(data_json => {
                if (data_json && data_json.statusCode) {
                    if (data_json.statusCode == '200') {//上传成功
                        console.log('上传成功:' + transfer.t_file_path);
                        DB.prepare(`UPDATE fileinfos SET syncTimeMS=@syncTimeMS WHERE id=@id; `).run({
                            id: transfer.t_f_id,
                            syncTimeMS: Date.now()
                        });
                        remove_downlist(transfer.t_id);
                    } else if (data_json.statusCode == '308') {//继续上传
                        if (data_json.rangeList && data_json.rangeList.length > 0) {
                            let range_arr = data_json.rangeList[0].split('-');
                            //继续拆分上传
                            DB.prepare(`UPDATE transfer_list SET t_url=@t_url,t_start=@t_start,t_end=@t_end,t_total=@t_total WHERE t_id=@t_id`).run(transfer);//先存一下上传成功的片段
                            upload(transfer);//递归上传
                        }
                    }
                }
            }
        ).catch(err => {
            console.log('上传错误,重置:' + transfer.t_file_path);
            transfer.t_url = '';
            transfer.t_start = 0;
            transfer.t_end = 0;
            transfer.t_total = 0;
            DB.prepare(`UPDATE transfer_list SET t_url=@t_url,t_start=@t_start,t_end=@t_end,t_total=@t_total WHERE t_id=@t_id`).run(transfer);//发生错误，重置上传
            upload(transfer);
            remove_downlist(transfer.t_id);
        });
    } else {
        remove_downlist(transfer.t_id);
    }
}

//url 是断点续传url
function _upload(url, fileOBJ, start, end, total, content_type, get_update = false) {
    let headers = {};
    if (get_update) {//是否是更新，更新的参数不一样
        headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(fileOBJ, 'utf8'),
            'X-Upload-Content-Type': content_type,
            'X-Upload-Content-Length': total,
            'Authorization': 'Bearer ' + ACCESS_TOKEN
        }
    } else {
        headers = {
            'Content-Type': content_type,
            'Content-Length': end - start,
            'Content-Range': `bytes ${start}-${end - 1}/${total}`,
            'Authorization': 'Bearer ' + ACCESS_TOKEN
        }
    }
    let options = {
        hostname: URL.parse(url).hostname,
        port: 443,
        path: URL.parse(url).path,
        method: 'PUT',
        headers: headers
    };
    //console.log(options);
    return new Promise((resolve, reject) => {
        let req = HTTPS.request(options, (res) => {
            // console.log(options);
            // console.log('headers:', res.statusCode);
            // console.log('headers:', res.headers);
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', function () {
                let data_json = JSON.parse(_data);
                if (data_json.error) {//说明有错误，显示出来
                    console.log(data_json.error);
                    reject(data_json);
                }
                data_json.statusCode = res.statusCode;
                data_json.headers = res.headers;
                resolve(data_json);
            });
        });
        req.on('error', reject);
        req.write(fileOBJ);
        req.end();
    });
}

function create_folder(folderOBJ) {//创建目录 https://developer.huawei.com/consumer/cn/doc/development/HMSCore-References/server-api-filescreate-0000001050151686
    let options = {
        hostname: 'driveapis.cloud.huawei.com.cn',
        port: 443,
        path: '/drive/v1/files?fields=*',
        method: 'POST',
        headers: {
            'Content-Type': 'application/application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(folderOBJ, 'utf8'),//如果含有中文，需要这样计算
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
    };

    return new Promise((resolve, reject) => {
        let req = HTTPS.request(options, (res) => {
            // console.log(res.headers);
            //res.setEncoding('utf-8');
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', function () {
                let data_json = JSON.parse(_data);
                if (data_json.error) {//说明有错误，显示出来
                    console.log(data_json.error);
                    console.log(folderOBJ);
                    reject(data_json);
                }
                resolve(data_json);
            });
        });
        req.on('error', reject);
        req.write(folderOBJ);
        req.end();
    });

}

function delete_file(f_id) {
    let options = {
        hostname: 'driveapis.cloud.huawei.com.cn',
        port: 443,
        path: '/drive/v1/files/' + f_id,
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': 0,
            Authorization: 'Bearer ' + ACCESS_TOKEN
        }
    };
    return new Promise((resolve, reject) => {
        let req = HTTPS.request(options, (res) => {
            let _data = '';
            res.on('data', (chunk) => {
                _data += chunk;
            });
            res.on('end', resolve(_data));
        });
        req.on('error', reject);
        req.end();
    });
}

//处理未完成的传输列表
async function do_transfer() {

    if (DOWN_LIST.length >= DOWN_LIST_NUMBER) {
        return false;
    }

    let limit = DOWN_LIST_NUMBER - DOWN_LIST.length;
    let ids = '';
    for (DOWN of DOWN_LIST) {
        ids += DOWN.t_id + ',';
    }
    ids += '0';
    let query = DB.prepare(`SELECT * FROM transfer_list  WHERE t_id NOT IN(${ids}) AND t_type!='delete_local'  ORDER BY t_id ASC LIMIT 0,${limit}`);//一个查询语句对象

    const transfer_list = query.all()//执行查询
    if (transfer_list.length == 0 && DOWN_LIST.length == 0) {
        console.log('传输任务全部完成!');
        clearInterval(DOWN_INTERVAL);
        return;
    }
    for (transfer of transfer_list) {
        DOWN_LIST.push(transfer);
        switch (transfer.t_type) {
            case 'download':
                console.log('正在下载:' + transfer.t_file_path);
                download(transfer.t_f_id, transfer.t_file_path).then(() => {
                    //todo 新建的下载需要插入记录
                    remove_downlist(transfer.t_id);
                    console.log('下载完成:' + transfer.t_file_path);
                });
                break;
            case 'update':
            case 'upload':
                upload(transfer);
                break;
            case'delete' :
                delete_file(transfer.id).then(data => {
                    remove_downlist(transfer.t_id);
                });
                console.log('删除文件' + transfer.id);
                break;
            case 'delete_local'://删除本地文件，在合并文件函数merge_file中处理
                break;
        }
    }

}

function remove_downlist(transfer_id) {
    LOCKER  //这是个互斥锁，防止数组读写错误
        .runExclusive(function () {
            DB.prepare('DELETE FROM transfer_list WHERE t_id = ?;').run(transfer_id);//删除数据库记录
            let find_index = DOWN_LIST.findIndex(item => {
                return item.t_id == transfer_id;
            });
            if (find_index !== -1) DOWN_LIST.splice(find_index, 1);
            do_transfer();
        })
        .then(function (result) {

        });
}

function hash256(file) {
    const buffer = FS.readFileSync(file);
    const hash = CRYPTO.createHash('sha256');
    hash.update(buffer);
    return hash.digest('hex');
}

//创建循环目录 /a/b/c/d/....
function mkdirP(p, mode, f, made) {
    if (typeof mode === 'function' || mode === undefined) {
        f = mode;
        mode = 0777 & (~process.umask());
    }
    if (!made) made = null;

    var cb = f || function () {
    };
    if (typeof mode === 'string') mode = parseInt(mode, 8);
    p = PATH.resolve(p);

    FS.mkdir(p, mode, function (er) {
        if (!er) {
            made = made || p;
            return cb(null, made);
        }
        switch (er.code) {
            case 'ENOENT':
                mkdirP(PATH.dirname(p), mode, function (er, made) {
                    if (er) cb(er, made);
                    else mkdirP(p, mode, cb, made);
                });
                break;
            default:
                FS.stat(p, function (er2, stat) {
                    if (er2 || !stat.isDirectory()) cb(er, made)
                    else cb(null, made);
                });
                break;
        }
    });
}


const MIMETYPES = {
    '.3gp': 'video/3gpp',
    '.apk': 'application/vnd.android.package-archive',
    '.asf': 'video/x-ms-asf',
    '.avi': 'video/x-msvideo',
    '.bin': 'application/octet-stream',
    '.bmp': 'image/bmp',
    '.c': 'text/plain',
    '.class': 'application/octet-stream',
    '.conf': 'text/plain',
    '.cpp': 'text/plain',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.exe': 'application/octet-stream',
    '.gif': 'image/gif',
    '.gtar': 'application/x-gtar',
    '.gz': 'application/x-gzip',
    '.h': 'text/plain',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.jar': 'application/java-archive',
    '.java': 'text/plain',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.jpe': 'image/jpeg',
    '.js': 'application/x-javascript',
    '.log': 'text/plain',
    '.m3u': 'audio/x-mpegurl',
    '.m4a': 'audio/mp4a-latm',
    '.m4b': 'audio/mp4a-latm',
    '.m4p': 'audio/mp4a-latm',
    '.m4u': 'video/vnd.mpegurl',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.mp2': 'audio/x-mpeg',
    '.mp3': 'audio/x-mpeg',
    '.mp4': 'video/mp4',
    '.mpc': 'application/vnd.mpohun.certificate',
    '.mpeg': 'video/mpeg',
    '.mpe': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.mpg4': 'video/mp4',
    '.mpga': 'audio/mpeg',
    '.msg': 'application/vnd.ms-outlook',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.pps': 'application/vnd.ms-powerpoint',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.prop': 'text/plain',
    '.rc': 'text/plain',
    '.rmvb': 'audio/x-pn-realaudio',
    '.rtf': 'application/rtf',
    '.sh': 'text/plain',
    '.tar': 'application/x-tar',
    '.tgz': 'application/x-compressed',
    '.txt': 'text/plain',
    '.wav': 'audio/x-wav',
    '.wma': 'audio/x-ms-wma',
    '.wmv': 'video/x-ms-wmv',
    '.wps': 'application/vnd.ms-works',
    '.xml': 'text/plain',
    '.z': 'application/x-compress',
    '.zip': 'application/x-zip-compressed',
    '.wbmp': 'image/vnd.wap.wbmp',
    '.webp': 'image/webp',
    '.raw': 'image/x-panasonic-raw',
    '.dng': 'image/x-adobe-dng',
    '.arw': 'image/x-sony-arw',
    '.tif': 'image/tiff',
    '.ico': 'image/x-icon',
    '.mpo': 'image/mpo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/x-matrosk',
    '.m2ts': 'video/mpeg',
    '.3g2': 'video/3gpp2',
    '.rm': 'video/x-pn-realvideo',
    '.rv': 'video/x-pn-realvideo',
    '.ts': 'video/mp2ts',
    '.flv': 'video/x-flv',
    '.k3g': 'video/k3g',
    'def': 'application/octet-stream'
}
