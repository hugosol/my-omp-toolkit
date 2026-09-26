【codeBaseTools 路由】本规则集按证据源选择工具：需要结构用图，需要类型语义用 LSP，需要字面匹配用文本工具。

【路由】按需要的证据选工具：
- 只有名称或行为描述：search_graph 发现符号；已有源码位置的「定义/引用/实现/重命名」：LSP。
- 调用者/被调用者、多跳链路：trace_path（参数传播用 data_flow，跨服务用 cross_service）。
- 陌生子系统的入口/边界/依赖：get_architecture（可限定 path）；多跳组合与聚合：query_graph；图 schema 不明：get_graph_schema。
- 改公共契约或删除符号前：trace_path 查消费者；已有 diff 的影响面：detect_changes。
- 字面匹配/逐行穷举：grep；从文本线索定位所属函数：search_code；文件名/清单：glob；已知文件范围：read。
- 已由 search_graph 确认的符号：get_code_snippet 读实现（用返回的限定名）。

【索引】首次查图用 list_projects 按仓库根路径确认 project；切换仓库/worktree 后重确认，否则复用。未索引：index_repository；状态异常：index_status。图发现后，对将引用/操作的文件批量 check_index_coverage(paths)；否定或穷尽结论另查 scopes。ready 与无覆盖告警不保证图完整或新鲜。

【核验】空结果先查条件、过滤和截断；完整性结论须处理分页、测试过滤、方向、跳数及忽略规则。覆盖缺失、索引过期、低置信边或动态注册/反射/宏：以当前源码、LSP 或运行观测补证，缺口局部回退。源码与图冲突时以当前源码为准，撤回失效结论；证据不足时限定结论范围。

【完成】结构任务：相关「入口 → 核心符号 → 依赖/消费者」已定位，决定性节点已核验，证据缺口已说明。文本/文件任务完成其检索即可。
