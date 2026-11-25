; Dimo installer localized strings (SimpChinese + English)
!ifndef DIMO_INSTALLER_STRINGS
!define DIMO_INSTALLER_STRINGS

!macro DIMO_STR ID ZH EN
  !ifdef LANG_SIMPCHINESE
    LangString ${ID} ${LANG_SIMPCHINESE} "${ZH}"
  !endif
  !ifdef LANG_ENGLISH
    LangString ${ID} ${LANG_ENGLISH} "${EN}"
  !endif
!macroend

!insertmacro DIMO_STR DIMO_TITLE_SETUP "${PRODUCT_NAME} 安装程序" "${PRODUCT_NAME} Setup"
!insertmacro DIMO_STR DIMO_TITLE_UNINSTALL "${PRODUCT_NAME} 卸载程序" "${PRODUCT_NAME} Uninstall"
!insertmacro DIMO_STR DIMO_VERSION_FMT "版本 ${VERSION}" "Version ${VERSION}"
!insertmacro DIMO_STR DIMO_INSTALL_NOW "立即安装" "Install now"
!insertmacro DIMO_STR DIMO_CUSTOMIZE "自定义安装位置 ›" "Customize location ›"
!insertmacro DIMO_STR DIMO_LOCATION "安装位置" "Install location"
!insertmacro DIMO_STR DIMO_BROWSE "浏览…" "Browse…"
!insertmacro DIMO_STR DIMO_CHOOSE_PATH "选择安装位置" "Choose install location"
!insertmacro DIMO_STR DIMO_SPACE_REQUIRED "所需空间" "Required"
!insertmacro DIMO_STR DIMO_SPACE_FREE "可用空间" "Available"
!insertmacro DIMO_STR DIMO_PAREN_L "（" " ("
!insertmacro DIMO_STR DIMO_PAREN_R "）" ")"
!insertmacro DIMO_STR DIMO_BACK "返回" "Back"
!insertmacro DIMO_STR DIMO_INSTALL "安装" "Install"
!insertmacro DIMO_STR DIMO_INSTALLED_FMT "已安装版本" "Installed version"
!insertmacro DIMO_STR DIMO_REINSTALL "覆盖安装" "Reinstall"
!insertmacro DIMO_STR DIMO_UNINSTALL "卸载" "Uninstall"
!insertmacro DIMO_STR DIMO_CANCEL "取消" "Cancel"
!insertmacro DIMO_STR DIMO_RETRY "重试" "Retry"
!insertmacro DIMO_STR DIMO_VIEW_LOG "查看日志" "View log"
!insertmacro DIMO_STR DIMO_LAUNCH_NOW "立即启动 ${PRODUCT_NAME}" "Launch ${PRODUCT_NAME} now"
!insertmacro DIMO_STR DIMO_FINISH "完成" "Finish"
!insertmacro DIMO_STR DIMO_INSTALLING "正在安装" "Installing"
!insertmacro DIMO_STR DIMO_INSTALL_DONE "安装完成" "Installation complete"
!insertmacro DIMO_STR DIMO_INSTALL_FAILED "安装未完成" "Installation incomplete"
!insertmacro DIMO_STR DIMO_UNINSTALLING "正在卸载" "Uninstalling"
!insertmacro DIMO_STR DIMO_UNINSTALLED_DONE "${PRODUCT_NAME} 已从此电脑移除" "${PRODUCT_NAME} has been removed"
!insertmacro DIMO_STR DIMO_UNINSTALL_SUB "将从此电脑移除 ${PRODUCT_NAME} ${VERSION}" "${PRODUCT_NAME} ${VERSION} will be removed from this PC"
!insertmacro DIMO_STR DIMO_DELETE_DATA "同时删除用户数据（设置、会话和缓存）" "Also delete user data (settings, sessions, cache)"
!insertmacro DIMO_STR DIMO_PROGRESS_PREPARE "正在准备安装…" "Preparing installation…"
!insertmacro DIMO_STR DIMO_PROGRESS_EXTRACT "正在复制文件…" "Copying files…"
!insertmacro DIMO_STR DIMO_PROGRESS_INSTALL "正在注册组件…" "Registering components…"
!insertmacro DIMO_STR DIMO_PROGRESS_FINISH "正在完成安装…" "Finishing installation…"
!insertmacro DIMO_STR DIMO_PROGRESS_UNINSTALL "正在移除文件…" "Removing files…"
!insertmacro DIMO_STR DIMO_EXTRACT_FAILED "应用文件解压失败" "Failed to extract application files"
!insertmacro DIMO_STR DIMO_COPY_FAILED "无法写入安装目录" "Unable to write to installation folder"
!insertmacro DIMO_STR DIMO_UNINSTALL_FAILED "无法卸载现有版本" "Failed to uninstall existing version"
!insertmacro DIMO_STR DIMO_ERROR_HINT "请关闭占用程序或检查磁盘空间后重试 · 错误代码" "Close conflicting apps or check disk space and retry · Error code"
!insertmacro DIMO_STR DIMO_PATH_INVALID "请选择有效的本地安装文件夹路径。" "Please choose a valid local installation folder path."
!insertmacro DIMO_STR DIMO_PATH_NOT_EMPTY "所选文件夹非空，请选择空文件夹或新建 ${PRODUCT_NAME} 子文件夹。" "The selected folder is not empty. Please choose an empty folder or a new ${PRODUCT_NAME} subfolder."

!endif
