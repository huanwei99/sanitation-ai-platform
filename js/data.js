// ============================================================
// 环卫项目AI管理程序 - 模拟数据
// ============================================================

// 岗位与组织架构
const organizationData = {
  name: '环卫项目公司',
  children: [
    {
      id: 'gm', name: '总经理', type: 'position',
      desc: '项目的上一级领导担任，对项目各项事务有最终决策权',
      children: [
        {
          id: 'pm', name: '项目经理', type: 'department', headcount: 1,
          desc: '主管项目全面事务',
          children: [
            {
              id: 'ops', name: '运营经理', type: 'position', headcount: 1,
              desc: '负责项目现场运营相关工作'
            },
            {
              id: 'finance', name: '财务部', type: 'department', headcount: '1-2',
              desc: '负责项目公司财务工作'
            },
            {
              id: 'admin', name: '综合管理部', type: 'department', headcount: '2-3',
              desc: '负责人事、行政、采购、仓管、品质、安全、外联等日常管理工作'
            },
            {
              id: 'mechanical', name: '机械作业部', type: 'department',
              children: [
                { id: 'mech-mgr', name: '经理', headcount: 1, desc: '负责项目机械化作业、人员和设备、安全及日常管理' },
                { id: 'mech-lead', name: '车队长', headcount: '1-3', desc: '负责本车队机械化作业、人员和设备、安全及日常管理' },
                { id: 'mech-driver', name: '司机', headcount: '若干', desc: '负责车辆设备日常作业和日常维护' },
                { id: 'mech-helper', name: '辅助工', headcount: '若干', desc: '随车辅助司机完成冲洗、浇灌、挂桶等工作' }
              ]
            },
            {
              id: 'manual', name: '人工作业部', type: 'department',
              children: [
                { id: 'man-mgr', name: '经理', headcount: 1, desc: '负责项目人工作业、人员、物资、安全等日常管理' },
                { id: 'man-area', name: '片区经理', headcount: '2-3', desc: '负责片区人工作业、人员、物资、安全等日常管理' },
                { id: 'man-team', name: '保洁作业班组长', headcount: '若干', desc: '负责小片区人工作业、人员、物资、安全等日常管理' },
                { id: 'man-worker', name: '保洁员', headcount: '若干', desc: '负责责任片区的清扫、保洁工作' },
                { id: 'man-mobile-lead', name: '机动保洁队长', headcount: '1-3', desc: '负责机动保洁组作业、人员、物资设备、安全等日常管理' },
                { id: 'man-mobile', name: '机动保洁队员', headcount: '若干', desc: '完成快速保洁、突击作业及小型设备保养维护' }
              ]
            }
          ]
        }
      ]
    }
  ]
};

// 员工数据
const employees = [
  { id: 1, name: '张伟', gender: '男', age: 45, position: '总经理', department: '管理层', phone: '138****1234', joinDate: '2020-03-15', education: '本科', type: '正式', status: '在职' },
  { id: 2, name: '李明', gender: '男', age: 38, position: '项目经理', department: '管理层', phone: '139****5678', joinDate: '2020-06-01', education: '大专', type: '正式', status: '在职' },
  { id: 3, name: '王芳', gender: '女', age: 32, position: '运营经理', department: '运营部', phone: '137****9012', joinDate: '2021-01-10', education: '本科', type: '正式', status: '在职' },
  { id: 4, name: '刘洋', gender: '男', age: 28, position: '综合管理员', department: '综合管理部', phone: '136****3456', joinDate: '2021-08-20', education: '大专', type: '正式', status: '在职' },
  { id: 5, name: '陈静', gender: '女', age: 35, position: '财务', department: '财务部', phone: '135****7890', joinDate: '2020-09-15', education: '本科', type: '正式', status: '在职' },
  { id: 6, name: '赵强', gender: '男', age: 42, position: '机械作业部经理', department: '机械作业部', phone: '134****2345', joinDate: '2020-04-01', education: '高中', type: '正式', status: '在职' },
  { id: 7, name: '孙磊', gender: '男', age: 36, position: '车队长', department: '机械作业部', phone: '133****6789', joinDate: '2021-03-15', education: '高中', type: '正式', status: '在职' },
  { id: 8, name: '周涛', gender: '男', age: 40, position: '司机', department: '机械作业部', phone: '132****0123', joinDate: '2021-05-20', education: '初中', type: '劳务派遣', status: '在职' },
  { id: 9, name: '吴杰', gender: '男', age: 44, position: '司机', department: '机械作业部', phone: '131****4567', joinDate: '2021-07-10', education: '初中', type: '劳务派遣', status: '在职' },
  { id: 10, name: '郑华', gender: '男', age: 39, position: '人工作业部经理', department: '人工作业部', phone: '130****8901', joinDate: '2020-05-01', education: '大专', type: '正式', status: '在职' },
  { id: 11, name: '马丽', gender: '女', age: 34, position: '片区经理', department: '人工作业部', phone: '158****2345', joinDate: '2021-02-15', education: '大专', type: '正式', status: '在职' },
  { id: 12, name: '黄勇', gender: '男', age: 37, position: '片区经理', department: '人工作业部', phone: '159****6789', joinDate: '2021-04-20', education: '高中', type: '正式', status: '在职' },
  { id: 13, name: '林小红', gender: '女', age: 48, position: '班组长', department: '人工作业部', phone: '157****0123', joinDate: '2020-08-10', education: '初中', type: '正式', status: '在职' },
  { id: 14, name: '何建国', gender: '男', age: 52, position: '保洁员', department: '人工作业部', phone: '156****4567', joinDate: '2020-10-01', education: '小学', type: '劳务派遣', status: '在职' },
  { id: 15, name: '罗秀英', gender: '女', age: 50, position: '保洁员', department: '人工作业部', phone: '155****8901', joinDate: '2021-01-15', education: '小学', type: '劳务派遣', status: '在职' },
  { id: 16, name: '胡明', gender: '男', age: 46, position: '机动保洁队长', department: '人工作业部', phone: '153****2345', joinDate: '2021-06-01', education: '高中', type: '正式', status: '在职' },
  { id: 17, name: '朱伟', gender: '男', age: 33, position: '辅助工', department: '机械作业部', phone: '152****6789', joinDate: '2022-02-10', education: '初中', type: '劳务派遣', status: '在职' },
  { id: 18, name: '徐丽', gender: '女', age: 29, position: '综合管理员', department: '综合管理部', phone: '151****0123', joinDate: '2022-05-15', education: '本科', type: '正式', status: '在职' },
];

// 考勤数据
const attendanceRecords = [
  { id: 1, employeeId: 8, name: '周涛', date: '2026-11-03', clockIn: '06:55', clockOut: '17:05', type: '正常', location: '城东片区', status: '已打卡' },
  { id: 2, employeeId: 9, name: '吴杰', date: '2026-11-03', clockIn: '07:02', clockOut: '17:10', type: '迟到', location: '城西片区', status: '已打卡' },
  { id: 3, employeeId: 14, name: '何建国', date: '2026-11-03', clockIn: '06:50', clockOut: '17:00', type: '正常', location: '城北片区A区', status: '已打卡' },
  { id: 4, employeeId: 15, name: '罗秀英', date: '2026-11-03', clockIn: '06:58', clockOut: null, type: '正常', location: '城北片区B区', status: '在岗' },
  { id: 5, employeeId: 13, name: '林小红', date: '2026-11-03', clockIn: '07:00', clockOut: '17:00', type: '正常', location: '城南片区', status: '已打卡' },
  { id: 6, employeeId: 17, name: '朱伟', date: '2026-11-03', clockIn: null, clockOut: null, type: '缺勤', location: '-', status: '未打卡' },
  { id: 7, employeeId: 16, name: '胡明', date: '2026-11-03', clockIn: '06:45', clockOut: '17:15', type: '正常', location: '机动片区', status: '已打卡' },
  { id: 8, employeeId: 6, name: '赵强', date: '2026-11-03', clockIn: '08:00', clockOut: '18:30', type: '正常', location: '办公室', status: '已打卡' },
  { id: 9, employeeId: 3, name: '王芳', date: '2026-11-03', clockIn: '08:05', clockOut: '18:00', type: '正常', location: '办公室', status: '已打卡' },
  { id: 10, employeeId: 11, name: '马丽', date: '2026-11-03', clockIn: '07:30', clockOut: '17:30', type: '正常', location: '城东片区', status: '已打卡' },
];

// 加班记录
const overtimeRecords = [
  { id: 1, employeeId: 14, name: '何建国', date: '2026-11-01', startTime: '17:00', endTime: '20:00', hours: 3, reason: '迎检突击保洁', approver: '林小红', status: '已批准' },
  { id: 2, employeeId: 16, name: '胡明', date: '2026-11-02', startTime: '06:00', endTime: '10:00', hours: 4, reason: '暴雨后应急保洁', approver: '郑华', status: '已批准' },
  { id: 3, employeeId: 8, name: '周涛', date: '2026-11-03', startTime: '17:00', endTime: '21:00', hours: 4, reason: '夜间冲洗作业', approver: '孙磊', status: '待审批' },
];

// 车辆数据
const vehicles = [
  { id: 1, plateNo: '豫A·12345', type: '大型洗扫车', fuelType: '新能源', brand: '宇通', model: 'ZKH5180TSL', purchaseDate: '2023-06-15', registerDate: '2023-07-01', inspectionExpiry: '2026-07-01', insuranceExpiry: '2026-12-15', status: '正常作业', driver: '周涛', department: '机械作业部', mileage: 45680 },
  { id: 2, plateNo: '豫A·23456', type: '压缩垃圾车', fuelType: '燃油', brand: '东风', model: 'DFH5180ZYSE', purchaseDate: '2022-03-20', registerDate: '2022-04-10', inspectionExpiry: '2026-04-10', insuranceExpiry: '2026-10-20', status: '正常作业', driver: '吴杰', department: '机械作业部', mileage: 78920 },
  { id: 3, plateNo: '豫A·34567', type: '高压冲洗车', fuelType: '新能源', brand: '比亚迪', model: 'BYD5180GPSE', purchaseDate: '2024-01-10', registerDate: '2024-02-01', inspectionExpiry: '2027-02-01', insuranceExpiry: '2027-01-10', status: '维修中', driver: '周涛', department: '机械作业部', mileage: 23450 },
  { id: 4, plateNo: '豫A·45678', type: '洒水车', fuelType: '燃油', brand: '解放', model: 'CA5180GPSE', purchaseDate: '2021-09-05', registerDate: '2021-10-01', inspectionExpiry: '2025-10-01', insuranceExpiry: '2026-09-05', status: '正常作业', driver: '吴杰', department: '机械作业部', mileage: 98760 },
  { id: 5, plateNo: '豫A·56789', type: '小型扫路机', fuelType: '新能源', brand: '福田', model: 'BJ5045TSL8', purchaseDate: '2024-08-15', registerDate: '2024-09-01', inspectionExpiry: '2027-09-01', insuranceExpiry: '2027-08-15', status: '正常作业', driver: '朱伟', department: '机械作业部', mileage: 12340 },
  { id: 6, plateNo: '豫A·67890', type: '护栏清洗车', fuelType: '燃油', brand: '江淮', model: 'HFC5082GQXE', purchaseDate: '2022-11-20', registerDate: '2022-12-05', inspectionExpiry: '2026-12-05', insuranceExpiry: '2026-11-20', status: '停场', driver: '-', department: '机械作业部', mileage: 56780 },
];

// 车辆维保记录
const maintenanceRecords = [
  { id: 1, vehicleId: 3, plateNo: '豫A·34567', type: '维修', date: '2026-11-01', desc: '液压系统故障维修', cost: 3500, reporter: '周涛', status: '维修中', estimatedComplete: '2026-11-05' },
  { id: 2, vehicleId: 1, plateNo: '豫A·12345', type: '保养', date: '2026-10-15', desc: '5000公里常规保养', cost: 800, reporter: '周涛', status: '已完成' },
  { id: 3, vehicleId: 2, plateNo: '豫A·23456', type: '维修', date: '2026-09-20', desc: '后桥密封更换', cost: 2200, reporter: '吴杰', status: '已完成' },
  { id: 4, vehicleId: 4, plateNo: '豫A·45678', type: '保养', date: '2026-10-28', desc: '10000公里大保养', cost: 1500, reporter: '吴杰', status: '已完成' },
];

// 加油记录
const fuelRecords = [
  { id: 1, vehicleId: 2, plateNo: '豫A·23456', date: '2026-11-03', fuelType: '柴油', liters: 120, cost: 936, mileage: 78920, station: '中石化城东站', reporter: '吴杰' },
  { id: 2, vehicleId: 4, plateNo: '豫A·45678', date: '2026-11-02', fuelType: '柴油', liters: 150, cost: 1170, mileage: 98760, station: '中石油城西服务站', reporter: '吴杰' },
  { id: 3, vehicleId: 1, plateNo: '豫A·12345', date: '2026-11-03', fuelType: '充电', liters: null, cost: 85, mileage: 45680, station: '公司充电桩', reporter: '周涛' },
  { id: 4, vehicleId: 2, plateNo: '豫A·23456', date: '2026-10-30', fuelType: '柴油', liters: 130, cost: 1014, mileage: 78780, station: '中石化城东站', reporter: '吴杰' },
];

// 品质安全检查记录
const inspectionRecords = [
  { id: 1, inspector: '马丽', inspectorRole: '片区经理', date: '2026-11-03', time: '09:30', location: '城东片区解放路段', category: '品质', severity: '一般', desc: '路面有散落垃圾未清扫', targetEmployee: '何建国', targetRole: '保洁员', photos: 2, status: '整改中', deadline: '2026-11-03 12:00' },
  { id: 2, inspector: '林小红', inspectorRole: '班组长', date: '2026-11-03', time: '10:15', location: '城南片区人民广场', category: '安全', severity: '严重', desc: '保洁员未穿反光背心作业', targetEmployee: '罗秀英', targetRole: '保洁员', photos: 1, status: '已整改', deadline: '2026-11-03 11:00' },
  { id: 3, inspector: '郑华', inspectorRole: '人工作业部经理', date: '2026-11-02', time: '14:00', location: '城北片区建设路', category: '品质', severity: '一般', desc: '果皮箱满溢未及时清理', targetEmployee: '林小红', targetRole: '班组长', photos: 3, status: '已整改', deadline: '2026-11-02 17:00' },
  { id: 4, inspector: '赵强', inspectorRole: '机械作业部经理', date: '2026-11-02', time: '08:30', location: '城东片区主干道', category: '品质', severity: '轻微', desc: '洗扫车作业速度偏慢', targetEmployee: '周涛', targetRole: '司机', photos: 0, status: '已整改', deadline: '2026-11-02 10:00' },
  { id: 5, inspector: '王芳', inspectorRole: '运营经理', date: '2026-11-01', time: '16:00', location: '城西片区', category: '安全', severity: '严重', desc: '车辆未设置警示标志进行作业', targetEmployee: '吴杰', targetRole: '司机', photos: 2, status: '已整改', deadline: '2026-11-01 17:00' },
];

// 奖惩记录
const rewardPunishmentRecords = [
  { id: 1, employeeId: 14, name: '何建国', type: '处罚', date: '2026-11-03', reason: '路面清扫不彻底，品质检查不合格', amount: -50, status: '待执行', approver: '马丽' },
  { id: 2, employeeId: 15, name: '罗秀英', type: '处罚', date: '2026-11-03', reason: '未穿反光背心作业，违反安全规定', amount: -100, status: '已执行', approver: '林小红' },
  { id: 3, employeeId: 16, name: '胡明', type: '奖励', date: '2026-11-02', reason: '暴雨应急保洁响应迅速，表现突出', amount: 200, status: '已执行', approver: '郑华' },
  { id: 4, employeeId: 8, name: '周涛', type: '奖励', date: '2026-10-30', reason: '月度优秀司机，安全无事故', amount: 300, status: '已执行', approver: '赵强' },
];

// 审批流程
const workflowRecords = [
  { id: 'WF-2026-001', type: '请假申请', applicant: '何建国', department: '人工作业部', date: '2026-11-02', leaveType: '事假', startDate: '2026-11-05', endDate: '2026-11-06', reason: '家中有事需处理', approver: '林小红', status: '审批中', currentStep: 1, totalSteps: 2 },
  { id: 'WF-2026-002', type: '采购申请', applicant: '刘洋', department: '综合管理部', date: '2026-11-01', purchaseItems: '保洁手套500双、垃圾袋2000个', estimatedCost: 2800, approver: '王芳', status: '已批准', currentStep: 2, totalSteps: 2 },
  { id: 'WF-2026-003', type: '维修申请', applicant: '周涛', department: '机械作业部', date: '2026-11-01', repairItem: '豫A·34567 高压冲洗车', repairDesc: '液压系统故障', estimatedCost: 3500, approver: '孙磊', status: '审批中', currentStep: 1, totalSteps: 3 },
  { id: 'WF-2026-004', type: '出差申请', applicant: '李明', department: '管理层', date: '2026-10-28', destination: '郑州', purpose: '参加环卫行业交流会', transport: '高铁', startDate: '2026-11-05', endDate: '2026-11-06', approver: '张伟', status: '已批准', currentStep: 1, totalSteps: 1 },
  { id: 'WF-2026-005', type: '用印申请', applicant: '刘洋', department: '综合管理部', date: '2026-10-25', documentName: '城东片区保洁服务合同', documentDesc: '与业主签订2027年度服务合同', approver: '王芳', status: '已批准', currentStep: 2, totalSteps: 2 },
  { id: 'WF-2026-006', type: '物资发放', applicant: '马丽', department: '人工作业部', date: '2026-11-03', items: '扫把20把、工作服15套', receivers: '城东片区全体保洁员', approver: '郑华', status: '审批中', currentStep: 1, totalSteps: 2 },
];

// 通知
const notifications = [
  { id: 1, title: '关于做好秋季落叶清扫工作的通知', sender: '王芳', senderRole: '运营经理', date: '2026-11-03', priority: '普通', content: '根据季节变化和业主要求，各片区需加强落叶清扫力度，增加巡回保洁频次。', read: false },
  { id: 2, title: '暴雨应急预案启动通知', sender: '李明', senderRole: '项目经理', date: '2026-11-02', priority: '紧急', content: '根据气象预报，今晚至明日有大暴雨，请各片区启动应急预案，确保排水口畅通，人员安全。', read: false },
  { id: 3, title: '11月份排班表发布', sender: '刘洋', senderRole: '综合管理员', date: '2026-11-01', priority: '普通', content: '11月份值班排班表已发布，请各部门人员查看确认。', read: true },
  { id: 4, title: '安全培训通知', sender: '赵强', senderRole: '机械作业部经理', date: '2026-10-30', priority: '重要', content: '定于11月5日下午2点在公司会议室开展车辆安全操作培训，请全体司机参加。', read: true },
];

// 工作日报
const dailyReports = [
  { id: 1, employeeId: 11, name: '马丽', role: '片区经理', date: '2026-11-03', content: '今日完成城东片区日常保洁巡查，发现解放路段有散落垃圾问题已安排整改。下午参加运营例会，汇报片区工作情况。', attachments: 2, generatedAt: '21:00' },
  { id: 2, employeeId: 6, name: '赵强', role: '机械作业部经理', date: '2026-11-03', content: '今日机械作业部出勤车辆5台，完成主干道洗扫作业28公里。豫A·34567高压冲洗车液压系统故障已送修。完成加油3车次。', attachments: 5, generatedAt: '21:00' },
  { id: 3, employeeId: 3, name: '王芳', role: '运营经理', date: '2026-11-03', content: '今日巡查城东、城南片区，品质整体良好。处理品质督查问题2件。发布秋季落叶清扫通知。审核采购申请1件。', attachments: 3, generatedAt: '21:05' },
];

// 待办事项
const todoItems = [
  { id: 1, title: '审批：何建国请假申请', type: '待办', from: '何建国', module: '流程', priority: '普通', deadline: '2026-11-04', status: 'pending' },
  { id: 2, title: '审批：周涛维修申请', type: '待办', from: '周涛', module: '流程', priority: '重要', deadline: '2026-11-04', status: 'pending' },
  { id: 3, title: '审批：马丽物资发放申请', type: '待办', from: '马丽', module: '流程', priority: '普通', deadline: '2026-11-05', status: 'pending' },
  { id: 4, title: '何建国品质问题整改确认', type: '待办', from: '系统', module: '品质安全', priority: '普通', deadline: '2026-11-03 12:00', status: 'pending' },
  { id: 5, title: '豫A·45678审车到期提醒', type: '待阅', from: '系统', module: '车辆管理', priority: '重要', deadline: '2026-10-01', status: 'pending' },
  { id: 6, title: '阅读：暴雨应急预案通知', type: '待阅', from: '李明', module: '通知', priority: '紧急', deadline: '-', status: 'pending' },
  { id: 7, title: '阅读：安全培训通知', type: '待阅', from: '赵强', module: '通知', priority: '重要', deadline: '2026-11-05', status: 'pending' },
];

// 工作群组
const workGroups = [
  { id: 1, name: '运营管理工作群', members: ['张伟', '李明', '王芳', '刘洋', '陈静', '赵强', '孙磊', '郑华', '马丽', '林小红', '胡明'], messageCount: 156, lastMessage: '王芳：秋季落叶清扫通知已发布', lastTime: '2026-11-03 10:30' },
  { id: 2, name: '车队工作群', members: ['李明', '王芳', '赵强', '刘洋', '孙磊', '周涛', '吴杰', '朱伟'], messageCount: 89, lastMessage: '孙磊：豫A·34567维修进度更新', lastTime: '2026-11-03 14:20' },
  { id: 3, name: '人工片区工作群', members: ['李明', '王芳', '郑华', '马丽', '黄勇', '林小红', '胡明'], messageCount: 203, lastMessage: '马丽：城东片区巡查完成', lastTime: '2026-11-03 17:00' },
];

// AI办公文档
const aiDocuments = [
  { id: 1, title: '2026年10月环卫作业质量月报', author: '刘洋', type: 'AI文档处理', date: '2026-11-01', status: '已定稿', desc: '根据各片区提交的数据和检查记录自动生成' },
  { id: 2, title: '城东片区保洁服务合同（2027年度）', author: '刘洋', type: 'AI法务', date: '2026-10-28', status: '审核中', desc: 'AI法务已提出3条修改建议，待提交人修改' },
  { id: 3, title: '暴雨中的坚守——环卫团队应急保洁纪实', author: '王芳', type: 'AI美文', date: '2026-11-02', status: '已发布', desc: '根据11月2日暴雨应急保洁现场照片和数据生成' },
  { id: 4, title: '11月3日运营例会纪要', author: '刘洋', type: '会议纪要', date: '2026-11-03', status: '待审核', desc: '根据会议录音自动生成，待人工审核' },
];

// 仪表盘统计数据
const dashboardStats = {
  todayDate: '2026-11-03',
  totalEmployees: 18,
  presentToday: 16,
  absentToday: 1,
  onDuty: 1,
  vehiclesTotal: 6,
  vehiclesActive: 4,
  vehiclesMaintenance: 1,
  vehiclesIdle: 1,
  inspectionsToday: 2,
  pendingIssues: 1,
  resolvedToday: 1,
  pendingApprovals: 3,
  overtimeToday: 1,
  alerts: [
    { type: 'warning', msg: '豫A·45678 审车已过期（2025-10-01）', time: '持续提醒' },
    { type: 'danger', msg: '豫A·34567 液压系统维修中', time: '预计11-05完成' },
    { type: 'info', msg: '何建国 事假申请待审批', time: '2026-11-02提交' },
  ]
};
